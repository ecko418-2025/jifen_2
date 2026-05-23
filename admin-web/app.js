const ENV_ID = 'cloud1-d2gpq0fat0dd3c17f'; // 你的环境 ID

// 初始化云开发
const app = cloudbase.init({
    env: ENV_ID
});
const auth = app.auth();
const db = app.database();
const _ = db.command;

// UI 状态
let currentTab = 'dashboard';
let editingPlayerId = null;

// 分页状态
let currentPageRooms = 1;
const PAGE_SIZE_ROOMS = 20;
let totalRooms = 0;

let currentPagePlayers = 1;
const PAGE_SIZE_PLAYERS = 50;
let totalPlayers = 0;
let qrPollTimer = null; // 二维码轮询定时器
let activeTicketId = null; // 当前正在轮询 the Ticket

// 批量删除房间状态
let selectedRoomIds = new Set();
let selectedRoomCodes = new Map();

// 页面元素
const contentArea = document.getElementById('content-area');
const tabTitle = document.getElementById('tab-title');
const envIdDisplay = document.getElementById('env-id');
const modal = document.getElementById('modal-overlay');

// ==========================================
// 辅助函数
// ==========================================
function calculateTransfers(players) {
    const debtors = [];
    const creditors = [];

    players.forEach(p => {
        const score = Number(p.current_score || 0);
        if (score < 0) {
            debtors.push({ player_id: p.player_id || null, name: p.nickname, amount: Math.abs(score) });
        } else if (score > 0) {
            creditors.push({ player_id: p.player_id || null, name: p.nickname, amount: score });
        }
    });

    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
        const amount = Math.min(debtors[i].amount, creditors[j].amount);
        transfers.push({
            from_player_id: debtors[i].player_id,
            from: debtors[i].name,
            to_player_id: creditors[j].player_id,
            to: creditors[j].name,
            amount
        });

        debtors[i].amount -= amount;
        creditors[j].amount -= amount;
        if (debtors[i].amount === 0) i++;
        if (creditors[j].amount === 0) j++;
    }

    return transfers;
}

function buildFinalSnapshot(players, tableFee) {
    const playerSnapshots = players.map(p => ({
        player_id: p._id,
        user_id: p.user_id || null,
        nickname: p.nickname || '未知用户',
        avatar: p.avatar || '',
        current_score: Number(p.current_score || 0),
        is_host: !!p.is_host,
        is_virtual: !!p.is_virtual,
        is_kicked: !!p.is_kicked
    }));
    const playersForSettle = playerSnapshots.map(p => ({
        player_id: p.player_id,
        nickname: p.nickname,
        current_score: p.current_score
    }));

    if (tableFee > 0) {
        playersForSettle.push({
            player_id: null,
            nickname: '台面 (结余)',
            current_score: tableFee
        });
    }

    return {
        version: 1,
        table_fee: tableFee,
        total_player_score: playerSnapshots.reduce((sum, p) => sum + p.current_score, 0),
        players: playerSnapshots,
        transfers: calculateTransfers(playersForSettle)
    };
}

// ==========================================
// 统一的 API 数据读写服务 (支持双模式二选一登录)
// ==========================================
const api = {
    // 核心的数据获取函数：获取记录总数
    async getCount(collectionName, condition = {}) {
        let query = db.collection(collectionName);
        if (Object.keys(condition).length > 0) {
            query = query.where(condition);
        }
        return await query.count();
    },

    // 核心的数据获取函数：获取记录列表
    async getList(collectionName, limitSize, skipSize = 0, condition = {}) {
        let query = db.collection(collectionName);
        if (Object.keys(condition).length > 0) {
            query = query.where(condition);
        }
        if (collectionName === 'Rooms') query = query.orderBy('created_at', 'desc');
        if (collectionName === 'Players') query = query.orderBy('joined_at', 'desc');
        
        const res = await query.skip(skipSize).limit(limitSize).get();
        let data = res.data;

        // 如果是玩家列表，手动查一下对应的房间号
        if (collectionName === 'Players' && data.length > 0) {
            const roomIds = [...new Set(data.map(p => p.room_id).filter(id => id))];
            if (roomIds.length > 0) {
                const roomsRes = await db.collection('Rooms').where({
                    _id: _.in(roomIds)
                }).field({
                    _id: true,
                    room_code: true
                }).get();
                
                const roomMap = {};
                roomsRes.data.forEach(r => {
                    roomMap[r._id] = r.room_code;
                });
                
                data = data.map(p => ({
                    ...p,
                    room_code: roomMap[p.room_id] || '未知'
                }));
            }
        }
        return { data };
    },

    // 核心的数据修改函数：修正玩家分数
    async updateScore(playerId, newScore) {
        return await db.collection('Players').doc(playerId).update({
            current_score: newScore,
            update_time: db.serverDate()
        });
    },

    // 核心的数据修改函数：结算房间 (同步生成快照)
    async settleRoom(roomId) {
        const roomRes = await db.collection('Rooms').doc(roomId).get();
        const room = Array.isArray(roomRes.data) ? roomRes.data[0] : roomRes.data;
        if (!room) throw new Error('房间不存在或已被删除');
        if (room.status === 'closed') return true;

        const playersRes = await db.collection('Players').where({ room_id: roomId }).limit(1000).get();
        const players = playersRes.data || [];
        
        const finalSnapshot = buildFinalSnapshot(players, Number(room.table_fee || 0));
        
        await db.collection('Rooms').doc(roomId).update({
            status: 'closed',
            closed_at: db.serverDate(),
            closed_by: 'WEB_ADMIN_DIRECT',
            final_snapshot: finalSnapshot
        });
        return true;
    },

    // 核心的数据修改函数：彻底删除房间
    async deleteRoom(roomId) {
        await Promise.all([
            db.collection('Rooms').doc(roomId).remove(),
            db.collection('Players').where({ room_id: roomId }).remove(),
            db.collection('Rounds').where({ room_id: roomId }).remove()
        ]);
        return true;
    },

    // 批量自动结算
    async batchAutoSettle(days) {
        const expireDays = days || 5;
        const cutoffTime = new Date(Date.now() - expireDays * 24 * 3600 * 1000);
        const activeRoomsRes = await db.collection('Rooms').where({ status: 'active' }).limit(100).get();
        let settledCount = 0;
        
        for (const room of activeRoomsRes.data) {
            const createdAt = room.created_at ? new Date(room.created_at) : null;
            if (createdAt && createdAt < cutoffTime) {
                const playersRes = await db.collection('Players').where({ room_id: room._id }).limit(1000).get();
                const players = playersRes.data || [];
                const finalSnapshot = buildFinalSnapshot(players, Number(room.table_fee || 0));
                
                await db.collection('Rooms').doc(room._id).update({
                    status: 'closed',
                    closed_at: db.serverDate(),
                    closed_by: 'WEB_ADMIN_BATCH',
                    final_snapshot: finalSnapshot
                });
                settledCount++;
            }
        }
        return { success: true, settledCount };
    }
};

// ==========================================
// 初始化与生命周期
// ==========================================
async function init() {
    envIdDisplay.innerText = ENV_ID;
    setupEventListeners();
    
    try {
        // 检查是否有账号密码登录态
        const freshLoginState = await auth.getLoginState();
        const loginType = freshLoginState ? String(freshLoginState.loginType || '').toLowerCase() : '';
        const isRealLogin = freshLoginState && loginType !== 'anonymous' && loginType !== '' && !freshLoginState.isAnonymousUser;
        
        console.log("当前登录态:", loginType, "判定为真实登录:", isRealLogin);
        
        if (isRealLogin) {
            console.log("账号密码登录态验证成功");
            document.getElementById('login-overlay').classList.add('hidden');
            loadTab('dashboard');
        } else {
            // 显示登录框并绑定事件
            document.getElementById('login-overlay').classList.remove('hidden');
            document.getElementById('login-submit-btn').onclick = handleLogin;
            
            // 绑定键盘回车
            document.getElementById('login-password').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleLogin();
            });
            document.getElementById('login-username').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleLogin();
            });
        }
    } catch (err) {
        console.error("检查登录态失败", err);
    }
}

// 处理用户名密码登录逻辑 (官方原生通道)
async function handleLogin() {
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const submitBtn = document.getElementById('login-submit-btn');
    const errorMsg = document.getElementById('login-error-msg');

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
        showLoginError("请输入管理员账号和密码");
        return;
    }

    try {
        submitBtn.innerText = "正在验证...";
        submitBtn.disabled = true;
        errorMsg.classList.add('hidden');

        // 健壮性防冲突处理：先执行登出，清空之前的异常状态
        try {
            await auth.signOut();
        } catch (e) {
            console.warn("登出旧状态失败，可忽略:", e);
        }
        
        // 使用用户名和密码登录（SDK v2 写法）
        await auth.signIn({
            signInMethod: 'username',
            username: username,
            password: password
        });
        
        console.log("密码登录成功");
        document.getElementById('login-overlay').classList.add('hidden');
        loadTab('dashboard');
    } catch (err) {
        console.error("登录失败", err);
        const errStr = JSON.stringify(err || {}) + (err.message || '') + (err.code || '') + (err.error || '');
        let msg = "账号或密码不正确";
        if (errStr.includes("USER_NOT_FOUND")) {
            msg = "该管理员账号不存在，请检查输入";
        } else if (errStr.includes("INVALID_PASSWORD")) {
            msg = "密码错误，请重新输入";
        } else if (errStr.includes("first_login_password_update_required") || errStr.includes("FIRST_LOGIN_PASSWORD")) {
            msg = "首次登录需修改密码！请前往控制台重置。";
        } else if (errStr.includes("OPERATION_FAIL")) {
            msg = "操作失败，请确认云开发已开启用户名密码登录";
        } else if (err.error_description) {
            msg = err.error_description;
        }
        showLoginError(msg);
    } finally {
        submitBtn.innerText = "登 录";
        submitBtn.disabled = false;
    }
}

// 弹出密码登录错误提示
function showLoginError(msg) {
    const errorMsg = document.getElementById('login-error-msg');
    errorMsg.innerText = `🚫 ${msg}`;
    errorMsg.classList.remove('hidden');
    
    // 触发抖动动画
    errorMsg.style.animation = 'none';
    errorMsg.offsetHeight; /* 触发重绘 */
    errorMsg.style.animation = null;
}

// 退出登录逻辑
async function handleLogout() {
    if (!confirm("确定要退出登录吗？")) return;
    try {
        // 清除云开发原生登录态
        await auth.signOut();
        console.log("已成功退出登录");
        
        // 刷新页面，重新显示登录框
        window.location.reload();
    } catch (err) {
        alert("退出登录失败：" + err.message);
    }
}

// 设置事件监听
function setupEventListeners() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const tab = e.target.closest('.nav-item').dataset.tab;
            loadTab(tab);
            
            // UI 更新
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            e.target.closest('.nav-item').classList.add('active');
        });
    });

    document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
    document.getElementById('save-btn').onclick = saveNewScore;
    document.getElementById('logout-btn').onclick = handleLogout;
}

// 切换标签页
async function loadTab(tab) {
    currentTab = tab;
    contentArea.innerHTML = '<div class="loading-spinner">数据同步中...</div>';
    
    switch(tab) {
        case 'dashboard':
            tabTitle.innerText = '仪表盘概览';
            renderDashboard();
            break;
        case 'rooms':
            tabTitle.innerText = '所有房间管理';
            renderRooms();
            break;
        case 'players':
            tabTitle.innerText = '活跃玩家列表';
            renderPlayers();
            break;
    }
}

// 渲染仪表盘
async function renderDashboard() {
    try {
        const roomsCount = await api.getCount('Rooms');
        const playersCount = await api.getCount('Players');
        const roundsCount = await api.getCount('Rounds');

        contentArea.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <h4>活跃房间</h4>
                    <div class="value">${roomsCount.total}</div>
                </div>
                <div class="stat-card">
                    <h4>总玩家数</h4>
                    <div class="value">${playersCount.total}</div>
                </div>
                <div class="stat-card">
                    <h4>历史流水记录</h4>
                    <div class="value">${roundsCount.total}</div>
                </div>
            </div>
            <div class="welcome-card">
                <h3>欢迎回来，管理员</h3>
                <p style="color: var(--text-dim); margin-top:10px;">在这里你可以实时监控狼人杀对局数据，并进行必要的分数修正。</p>
            </div>
        `;
    } catch (err) {
        contentArea.innerHTML = `<div class="error">加载失败: ${err.message}</div>`;
    }
}

// 渲染房间列表
window.renderRooms = renderRooms;
async function renderRooms(page = 1) {
    try {
        currentPageRooms = page;
        if (page === 1) {
            const countRes = await api.getCount('Rooms');
            totalRooms = countRes.total || 0;
        }
        
        const skip = (page - 1) * PAGE_SIZE_ROOMS;
        const res = await api.getList('Rooms', PAGE_SIZE_ROOMS, skip);
        const rooms = res.data || [];
        
        if (rooms.length === 0) {
            contentArea.innerHTML = '<div class="loading-spinner">📭 暂无房间数据</div>';
            return;
        }

        // 计算每个房间的存活天数
        const now = Date.now();

        let html = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
                <p style="color:var(--text-dim); font-size:13px;">共 ${rooms.length} 个房间</p>
                <div>
                    <button id="batch-delete-btn" class="btn-sm" style="background:var(--danger); color:#fff; font-weight:600; padding:8px 16px; margin-right:10px; display:${selectedRoomIds.size > 0 ? 'inline-block' : 'none'}; border:none;" onclick="handleBatchDeleteRooms()">
                        🗑️ 批量删除选中房间 (<span id="selected-count">${selectedRoomIds.size}</span>)
                    </button>
                    <button class="btn-sm" style="background:var(--warning); color:#000; font-weight:600; padding:8px 16px;" onclick="handleBatchAutoSettle()">
                        ⏰ 一键结算超时房间（>5天）
                    </button>
                </div>
            </div>
            <div class="data-table-container">
                <table>
                    <thead>
                        <tr>
                            <th style="width: 40px; text-align: center;">
                                <input type="checkbox" id="select-all-rooms" onclick="toggleSelectAllRooms(this)" style="cursor:pointer; width:16px; height:16px;">
                            </th>
                            <th>房间号</th>
                            <th>状态</th>
                            <th>台面费</th>
                            <th>创建时间</th>
                            <th>房龄</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        rooms.forEach(room => {
            // 状态判断：active / settled / closed
            let statusLabel, statusColor;
            if (room.status === 'closed') {
                statusLabel = '🔴 已关闭';
                statusColor = 'var(--danger)';
            } else if (room.status === 'settled') {
                statusLabel = '🟡 已结算';
                statusColor = 'var(--warning)';
            } else {
                statusLabel = '🟢 活跃中';
                statusColor = 'var(--success)';
            }

            // 计算房龄
            const createdAt = room.created_at ? new Date(room.created_at) : null;
            let ageText = '未知';
            let isExpired = false;
            if (createdAt) {
                const diffDays = Math.floor((now - createdAt.getTime()) / (24 * 3600 * 1000));
                if (diffDays === 0) {
                    ageText = '今天';
                } else if (diffDays === 1) {
                    ageText = '1天前';
                } else {
                    ageText = diffDays + '天前';
                }
                isExpired = diffDays >= 5;
            }

            // 操作按钮：根据状态显示不同按钮
            let actions = '';
            if (room.status === 'active') {
                actions = `
                    <button class="btn-sm" style="background:var(--warning);color:#000;margin-right:4px;" onclick="handleSettleRoom('${room._id}', '${room.room_code}')">结算</button>
                    <button class="btn-sm" style="background:rgba(255,60,60,0.15);color:var(--danger);" onclick="handleDeleteRoom('${room._id}', '${room.room_code}')">删除</button>
                `;
            } else {
                actions = `
                    <button class="btn-sm" style="background:rgba(255,60,60,0.15);color:var(--danger);" onclick="handleDeleteRoom('${room._id}', '${room.room_code}')">删除</button>
                `;
            }

            html += `
                <tr style="${isExpired && room.status === 'active' ? 'background:rgba(255,180,0,0.05);' : ''}">
                    <td style="text-align: center;">
                        <input type="checkbox" class="room-checkbox" data-id="${room._id}" data-code="${room.room_code || ''}" ${selectedRoomIds.has(room._id) ? 'checked' : ''} onclick="handleRoomSelect(this)" style="cursor:pointer; width:16px; height:16px;">
                    </td>
                    <td><code>${room.room_code || 'N/A'}</code></td>
                    <td style="color:${statusColor}; font-weight:600;">${statusLabel}</td>
                    <td>${room.table_fee || 0}</td>
                    <td>${createdAt ? createdAt.toLocaleString() : '未知'}</td>
                    <td style="${isExpired ? 'color:var(--warning);font-weight:600;' : ''}">${ageText}${isExpired && room.status === 'active' ? ' ⚠️' : ''}</td>
                    <td>${actions}</td>
                </tr>
            `;
        });
        
        html += '</tbody></table></div>';
        
        const totalPages = Math.ceil(totalRooms / PAGE_SIZE_ROOMS) || 1;
        html += `
            <div class="pagination" style="margin-top: 15px; display: flex; justify-content: center; align-items: center; gap: 10px;">
                <button class="btn-sm" ${page === 1 ? 'disabled' : ''} onclick="renderRooms(${page - 1})">上一页</button>
                <span style="color: var(--text-dim); font-size: 14px;">第 ${page} / ${totalPages} 页</span>
                <button class="btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="renderRooms(${page + 1})">下一页</button>
            </div>
        `;
        
        contentArea.innerHTML = html;

        // 检查并自动回显表头全选框的状态
        const checkboxes = document.querySelectorAll('.room-checkbox');
        const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);
        const selectAllCheckbox = document.getElementById('select-all-rooms');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = allChecked;
        }
        
        // 绑定到全局
        window.handleSettleRoom = handleSettleRoom;
        window.handleDeleteRoom = handleDeleteRoom;
        window.handleBatchAutoSettle = handleBatchAutoSettle;
        window.toggleSelectAllRooms = toggleSelectAllRooms;
        window.handleRoomSelect = handleRoomSelect;
        window.handleBatchDeleteRooms = handleBatchDeleteRooms;
    } catch (err) {
        console.error(err);
        contentArea.innerHTML = `<div class="error">加载失败: ${err.message}</div>`;
    }
}

// 处理结算房间
async function handleSettleRoom(roomId, roomCode) {
    if (!confirm(`确定将房间 [${roomCode}] 标记为"已结算"吗？\n结算后将生成最终分数快照，并停止记账。`)) return;
    
    try {
        await api.settleRoom(roomId);
        alert('房间已标记为已结算');
        loadTab('rooms');
    } catch (err) {
        alert('结算失败: ' + err.message);
    }
}

// 处理删除房间
async function handleDeleteRoom(roomId, roomCode) {
    if (!confirm(`⚠️ 确定要永久删除房间 [${roomCode}] 吗？\n\n此操作将同时删除该房间下的所有玩家记录和流水记录，且无法恢复！`)) return;
    if (!confirm(`再次确认：真的要删除房间 [${roomCode}] 吗？数据不可恢复！`)) return;
    
    try {
        await api.deleteRoom(roomId);
        alert('房间及其关联数据已永久删除');
        // 同步清理勾选缓存
        selectedRoomIds.delete(roomId);
        selectedRoomCodes.delete(roomId);
        loadTab('rooms');
    } catch (err) {
        alert('删除失败: ' + err.message);
    }
}

// 一键批量结算超时房间
async function handleBatchAutoSettle() {
    if (!confirm('确定要将所有超过 5 天的活跃房间自动标记为"已结算"吗？')) return;
    
    try {
        const result = await api.batchAutoSettle(5);
        alert(`批量结算完成！共结算了 ${result.settledCount} 个超时房间。`);
        loadTab('rooms');
    } catch (err) {
        alert('批量结算失败: ' + err.message);
    }
}

// 批量删除交互相关逻辑
function handleRoomSelect(checkbox) {
    const roomId = checkbox.dataset.id;
    const roomCode = checkbox.dataset.code;
    
    if (checkbox.checked) {
        selectedRoomIds.add(roomId);
        if (roomCode) selectedRoomCodes.set(roomId, roomCode);
    } else {
        selectedRoomIds.delete(roomId);
        selectedRoomCodes.delete(roomId);
    }
    
    updateBatchDeleteUI();
    
    // 检查是否全选
    const checkboxes = document.querySelectorAll('.room-checkbox');
    const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);
    const selectAllCheckbox = document.getElementById('select-all-rooms');
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = allChecked;
    }
}

function toggleSelectAllRooms(masterCheckbox) {
    const isChecked = masterCheckbox.checked;
    const checkboxes = document.querySelectorAll('.room-checkbox');
    
    checkboxes.forEach(cb => {
        cb.checked = isChecked;
        const roomId = cb.dataset.id;
        const roomCode = cb.dataset.code;
        
        if (isChecked) {
            selectedRoomIds.add(roomId);
            if (roomCode) selectedRoomCodes.set(roomId, roomCode);
        } else {
            selectedRoomIds.delete(roomId);
            selectedRoomCodes.delete(roomId);
        }
    });
    
    updateBatchDeleteUI();
}

function updateBatchDeleteUI() {
    const btn = document.getElementById('batch-delete-btn');
    const countEl = document.getElementById('selected-count');
    if (btn && countEl) {
        countEl.innerText = selectedRoomIds.size;
        btn.style.display = selectedRoomIds.size > 0 ? 'inline-block' : 'none';
    }
}

// 批量删除选中的房间
async function handleBatchDeleteRooms() {
    const size = selectedRoomIds.size;
    if (size === 0) return;
    
    const codes = Array.from(selectedRoomCodes.values()).filter(c => c);
    const codesText = codes.length > 0 ? codes.join(', ') : '所选的';
    
    if (!confirm(`⚠️ 确定要永久删除以下选中的 ${size} 个房间吗？\n\n[ 房间号: ${codesText} ]\n\n此操作将同时删除这些房间下的所有玩家记录和流水记录，且无法恢复！`)) return;
    if (!confirm(`再次确认：真的要永久删除这些房间吗？数据不可恢复！`)) return;
    
    try {
        const ids = Array.from(selectedRoomIds);
        contentArea.innerHTML = '<div class="loading-spinner">🗑️ 正在批量删除房间及关联数据，请稍候...</div>';
        
        // 并发进行彻底删除
        await Promise.all(ids.map(id => api.deleteRoom(id)));
        
        alert(`成功删除 ${size} 个房间及其所有关联数据`);
        selectedRoomIds.clear();
        selectedRoomCodes.clear();
        loadTab('rooms');
    } catch (err) {
        alert('批量删除失败: ' + err.message);
        loadTab('rooms');
    }
}   


// 渲染玩家列表
window.renderPlayers = renderPlayers;

let showVirtualPlayers = false;
window.toggleVirtualPlayers = function() {
    showVirtualPlayers = !showVirtualPlayers;
    renderPlayers(1);
};

async function renderPlayers(page = 1) {
    try {
        currentPagePlayers = page;
        const condition = showVirtualPlayers ? {} : { is_virtual: _.neq(true) };
        
        if (page === 1) {
            const countRes = await api.getCount('Players', condition);
            totalPlayers = countRes.total || 0;
        }
        
        const skip = (page - 1) * PAGE_SIZE_PLAYERS;
        const res = await api.getList('Players', PAGE_SIZE_PLAYERS, skip, condition);
        const players = res.data || [];

        if (players.length === 0) {
            contentArea.innerHTML = `
                <div style="display: flex; justify-content: flex-end; margin-bottom: 10px;">
                    <button class="btn-sm" onclick="toggleVirtualPlayers()">
                        ${showVirtualPlayers ? '👁 隐藏虚拟玩家' : '👁 显示虚拟玩家'}
                    </button>
                </div>
                <div class="loading-spinner">📭 暂无玩家数据</div>
            `;
            return;
        }
        
        let html = `
            <div style="display: flex; justify-content: flex-end; margin-bottom: 15px;">
                <button class="btn-sm" onclick="toggleVirtualPlayers()">
                    ${showVirtualPlayers ? '👁 隐藏虚拟玩家' : '👁 显示虚拟玩家'}
                </button>
            </div>
            <div class="data-table-container">
                <table>
                    <thead>
                        <tr>
                            <th>头像</th>
                            <th>昵称</th>
                            <th>所在房间</th>
                            <th>当前分数</th>
                            <th>角色</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        const groupedPlayers = {};
        players.forEach(p => {
            // 使用 user_id (即微信的 openid) 作为第一聚类主键，对于没有的虚拟玩家回退到 nickname
            const key = p.user_id || p.openid || p._openid || p.nickname || '未知玩家';
            if (!groupedPlayers[key]) {
                groupedPlayers[key] = {
                    nickname: p.nickname || '未知玩家',
                    avatar: p.avatar,
                    totalScore: 0,
                    instances: []
                };
            }
            groupedPlayers[key].totalScore += p.current_score || 0;
            groupedPlayers[key].instances.push(p);
        });

        Object.values(groupedPlayers).forEach((group, index) => {
            const hasMultiple = group.instances.length > 1;
            const groupId = 'player-group-' + index;
            
            html += `
                <tr style="${hasMultiple ? 'cursor:pointer; background:var(--bg-card-hover);' : ''}" onclick="${hasMultiple ? `toggleGroup('${groupId}')` : ''}">
                    <td><img src="${group.avatar}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;" onerror="this.src='https://mmbiz.qpic.cn/mmbiz_png/icTdbqWNOwNRna42FI242Lcia07xvkWModszK68mKzVnI6zXk7Sdl7n1icA2Ebicic4icib4X0kicqG4nBVzNszM1EicicHA/640?wx_fmt=png'"></td>
                    <td style="font-weight:bold;">
                        ${group.nickname}
                        ${hasMultiple ? `<span style="font-size:12px;color:var(--text-dim);margin-left:5px;">(${group.instances.length} 个记录) ▼</span>` : ''}
                    </td>
                    <td>${hasMultiple ? '<span style="color:var(--text-dim);">多房间</span>' : `<code>${group.instances[0].room_code || '未知'}</code>`}</td>
                    <td style="font-weight:700; color:${group.totalScore >= 0 ? 'var(--success)' : 'var(--danger)'}">
                        ${group.totalScore}
                    </td>
                    <td>${hasMultiple ? '-' : (group.instances[0].is_host ? '👑 房主' : (group.instances[0].is_virtual ? '🤖 虚拟' : '👤 玩家'))}</td>
                    <td>
                        ${hasMultiple ? '' : `<button class="btn-sm" onclick="openEditModal('${group.instances[0]._id}', '${group.instances[0].nickname}', ${group.instances[0].current_score}); event.stopPropagation();">修正</button>`}
                    </td>
                </tr>
            `;
            
            if (hasMultiple) {
                group.instances.forEach(player => {
                    html += `
                        <tr class="${groupId} hidden" style="background: rgba(0,0,0,0.15);">
                            <td style="text-align:right; color:var(--text-dim);">↳</td>
                            <td style="color:var(--text-dim); font-size:13px;">${player.nickname || '未知'} (对局)</td>
                            <td><code>${player.room_code || '未知'}</code></td>
                            <td style="font-weight:700; color:${player.current_score >= 0 ? 'var(--success)' : 'var(--danger)'}">
                                ${player.current_score}
                            </td>
                            <td>${player.is_host ? '👑 房主' : (player.is_virtual ? '🤖 虚拟' : '👤 玩家')}</td>
                            <td>
                                <button class="btn-sm" onclick="openEditModal('${player._id}', '${player.nickname}', ${player.current_score})">修正</button>
                            </td>
                        </tr>
                    `;
                });
            }
        });
        
        html += '</tbody></table></div>';
        
        const totalPages = Math.ceil(totalPlayers / PAGE_SIZE_PLAYERS) || 1;
        html += `
            <div class="pagination" style="margin-top: 15px; display: flex; justify-content: center; align-items: center; gap: 10px;">
                <button class="btn-sm" ${page === 1 ? 'disabled' : ''} onclick="renderPlayers(${page - 1})">上一页</button>
                <span style="color: var(--text-dim); font-size: 14px;">第 ${page} / ${totalPages} 页</span>
                <button class="btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="renderPlayers(${page + 1})">下一页</button>
            </div>
        `;
        
        contentArea.innerHTML = html;
        
        // 绑定折叠函数到全局
        window.toggleGroup = function(groupId) {
            document.querySelectorAll('.' + groupId).forEach(el => el.classList.toggle('hidden'));
        };
    } catch (err) {
        console.error(err);
        contentArea.innerHTML = `<div class="error">加载失败: ${err.message}</div>`;
    }
}

// 打开修改弹窗
function openEditModal(id, name, score) {
    editingPlayerId = id;
    document.getElementById('edit-player-name').innerText = `正在为 [${name}] 修正分数`;
    document.getElementById('current-score-input').value = score;
    document.getElementById('new-score-input').value = score;
    modal.classList.remove('hidden');
}

// 保存新分数
async function saveNewScore() {
    const newScore = parseInt(document.getElementById('new-score-input').value);
    if (isNaN(newScore)) return alert('请输入有效数字');

    try {
        const btn = document.getElementById('save-btn');
        btn.innerText = '保存中...';
        btn.disabled = true;

        await api.updateScore(editingPlayerId, newScore);

        alert('修改成功！');
        modal.classList.add('hidden');
        loadTab('players');
    } catch (err) {
        alert('修改失败: ' + err.message);
    } finally {
        const btn = document.getElementById('save-btn');
        btn.innerText = '确认保存';
        btn.disabled = false;
    }
}

// 启动
window.onload = init;
