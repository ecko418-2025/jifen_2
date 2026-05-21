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

// 页面元素
const contentArea = document.getElementById('content-area');
const tabTitle = document.getElementById('tab-title');
const envIdDisplay = document.getElementById('env-id');
const modal = document.getElementById('modal-overlay');

// ==========================================
// 统一的 API 数据读写服务 (支持双模式二选一登录)
// ==========================================
const api = {
    // 检查当前是否是用 Session 登录（扫码登录模式）
    isSessionMode() {
        return !!localStorage.getItem('admin_session_token');
    },
    
    // 获取当前的授权 Session Token
    getSessionToken() {
        return localStorage.getItem('admin_session_token');
    },

    // 核心的数据获取函数：获取记录总数
    async getCount(collectionName) {
        if (this.isSessionMode()) {
            const res = await app.callFunction({
                name: 'room-manager',
                data: {
                    action: 'adminAction',
                    sessionToken: this.getSessionToken(),
                    subAction: 'count',
                    collection: collectionName
                }
            });
            if (res.result && res.result.success) return { total: res.result.total };
            throw new Error(res.result.error || '获取统计失败');
        } else {
            return await db.collection(collectionName).count();
        }
    },

    // 核心的数据获取函数：获取记录列表
    async getList(collectionName, limitSize, skipSize = 0) {
        if (this.isSessionMode()) {
            const res = await app.callFunction({
                name: 'room-manager',
                data: {
                    action: 'adminAction',
                    sessionToken: this.getSessionToken(),
                    subAction: 'list',
                    collection: collectionName,
                    limit: limitSize,
                    skip: skipSize
                }
            });
            if (res.result && res.result.success) return { data: res.result.data };
            throw new Error(res.result.error || '获取列表失败');
        } else {
            // 直接数据库模式：手动处理排序和关联
            let query = db.collection(collectionName);
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
        }
    },

    // 核心的数据修改函数：修正玩家分数
    async updateScore(playerId, newScore) {
        if (this.isSessionMode()) {
            const res = await app.callFunction({
                name: 'room-manager',
                data: {
                    action: 'adminAction',
                    sessionToken: this.getSessionToken(),
                    subAction: 'updateScore',
                    playerId: playerId,
                    score: newScore
                }
            });
            if (res.result && res.result.success) return true;
            throw new Error(res.result.error || '修改分数失败');
        } else {
            return await db.collection('Players').doc(playerId).update({
                current_score: newScore,
                update_time: db.serverDate()
            });
        }
    },

    // 核心的数据修改函数：结算房间 (同步生成快照)
    async settleRoom(roomId) {
        const res = await app.callFunction({
            name: 'room-manager',
            data: {
                action: 'adminAction',
                sessionToken: this.getSessionToken(),
                subAction: 'settleRoom',
                roomId: roomId
            }
        });
        if (res.result && res.result.success) return true;
        throw new Error(res.result.error || '结算失败');
    },

    // 核心的数据修改函数：彻底删除房间
    async deleteRoom(roomId) {
        const res = await app.callFunction({
            name: 'room-manager',
            data: {
                action: 'adminAction',
                sessionToken: this.getSessionToken(),
                subAction: 'deleteRoom',
                roomId: roomId
            }
        });
        if (res.result && res.result.success) return true;
        throw new Error(res.result.error || '删除失败');
    },

    // 批量自动结算
    async batchAutoSettle(days) {
        const res = await app.callFunction({
            name: 'room-manager',
            data: {
                action: 'adminAction',
                sessionToken: this.getSessionToken(),
                subAction: 'batchAutoSettle',
                expireDays: days
            }
        });
        if (res.result && res.result.success) return res.result;
        throw new Error(res.result.error || '批量操作失败');
    }
};

// ==========================================
// 初始化与生命周期
// ==========================================
async function init() {
    envIdDisplay.innerText = ENV_ID;
    setupEventListeners();
    
    // 把切换 Tab 函数暴露给全局 onclick
    window.switchLoginTab = switchLoginTab;
    
    try {
        // 首先进行匿名登录，以确保能够调用云函数（无论什么登录模式，匿名登录都是底层安全底座，否则无法调用 app.callFunction）
        const loginState = await auth.getLoginState();
        if (!loginState) {
            await auth.signInAnonymously();
            console.log("匿名基础登录成功");
        }

        // 1. 判断是否持有扫码 sessionToken
        if (api.isSessionMode()) {
            try {
                // 尝试用代理拉取一次数据来测试 session 是否依然有效
                await api.getCount('Rooms');
                console.log("SessionToken 验证成功，扫码模式登录");
                document.getElementById('login-overlay').classList.add('hidden');
                loadTab('dashboard');
                return;
            } catch (e) {
                console.warn("SessionToken 已失效，自动注销", e);
                localStorage.removeItem('admin_session_token');
            }
        }
        
        // 2. 检查是否有账号密码登录态（非匿名登录态）
        const freshLoginState = await auth.getLoginState();
        const loginType = freshLoginState ? String(freshLoginState.loginType || '').toLowerCase() : '';
        const isRealLogin = freshLoginState && loginType !== 'anonymous' && loginType !== '' && !freshLoginState.isAnonymousUser;
        
        console.log("当前登录态:", loginType, "isAnonymous:", freshLoginState?.isAnonymousUser, "判定为真实登录:", isRealLogin);
        
        if (isRealLogin) {
            console.log("账号密码登录态验证成功");
            document.getElementById('login-overlay').classList.add('hidden');
            loadTab('dashboard');
        } else {
            // 3. 两种登录态均无，显示登录框并绑定事件
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

// ==========================================
// 双登录方式二选一切换
// ==========================================
function switchLoginTab(mode) {
    // 1. 样式更新
    document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-${mode}`).classList.add('active');
    
    // 2. 区域隐藏与显示
    if (mode === 'password') {
        document.getElementById('password-login-section').classList.remove('hidden');
        document.getElementById('qrcode-login-section').classList.add('hidden');
        // 停止二维码轮询
        stopQRCodePolling();
    } else {
        document.getElementById('password-login-section').classList.add('hidden');
        document.getElementById('qrcode-login-section').classList.remove('hidden');
        // 开始加载二维码并轮询
        startQRCodeLogin();
    }
}

// 开始微信扫码登录流程
async function startQRCodeLogin() {
    stopQRCodePolling();
    
    const qrPlaceholder = document.getElementById('qrcode-loading');
    const qrImg = document.getElementById('qrcode-img');
    const successOverlay = document.getElementById('qrcode-success-overlay');
    
    // 重置 UI
    qrPlaceholder.classList.remove('hidden');
    qrImg.classList.add('hidden');
    successOverlay.classList.add('hidden');
    
    try {
        // 调用云函数，获取体验版 (trial) 的小程序登录码，方便开发者和管理员随时扫码
        const res = await app.callFunction({
          name: 'room-manager',
          data: {
              action: 'createLoginTicket',
              data: { envVersion: 'trial' }
          }
        });
        
        if (res.result && res.result.success) {
            activeTicketId = res.result.ticketId;
            // 如果微信小程序码生成为空（例如本地小程序未发布），则降级为普通二维码，可通过小程序扫码功能扫描登录
            qrImg.src = res.result.qrBase64 || `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${res.result.ticketId}`;
            
            qrPlaceholder.classList.add('hidden');
            qrImg.classList.remove('hidden');
            
            // 启动每 2 秒一次的轮询检测
            qrPollTimer = setInterval(pollTicketStatus, 2000);
        } else {
            qrPlaceholder.innerHTML = `<p style="color:var(--danger)">生成失败: ${res.result.error || '未知错误'}</p>`;
        }
    } catch (err) {
        console.error("生成登录二维码失败", err);
        qrPlaceholder.innerHTML = `<p style="color:var(--danger)">生成失败，请检查网络</p>`;
    }
}

// 轮询检查 Ticket 状态
async function pollTicketStatus() {
    if (!activeTicketId) return;
    try {
        const res = await app.callFunction({
            name: 'room-manager',
            data: {
                action: 'checkTicket',
                data: { ticket: activeTicketId }
            }
        });
        
        if (res.result && res.result.success) {
            const status = res.result.status;
            if (status === 'authorized') {
                // 授权成功！
                stopQRCodePolling();
                document.getElementById('qrcode-success-overlay').classList.remove('hidden');
                
                // 将 sessionToken 写入 localStorage
                localStorage.setItem('admin_session_token', res.result.sessionToken);
                
                // 1.5 秒后自动关闭遮罩并加载首页数据
                setTimeout(() => {
                    document.getElementById('login-overlay').classList.add('hidden');
                    loadTab('dashboard');
                }, 1500);
            }
        }
    } catch (err) {
        console.warn("轮询 Ticket 状态失败", err);
    }
}

function stopQRCodePolling() {
    if (qrPollTimer) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
    }
    activeTicketId = null;
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

        // 如果之前有扫码 Token，需要清除，确保走账号密码直连通道
        localStorage.removeItem('admin_session_token');

        // auth is global
        
        // 健壮性防冲突处理：先执行登出，清空之前的匿名登录态或其他冲突状态
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
            msg = "首次登录需修改密码！请前往腾讯云开发控制台 → 身份认证 → 用户管理 → 找到您的账号 → 重置密码，然后再回来登录。";
        } else if (errStr.includes("OPERATION_FAIL")) {
            msg = "操作失败，请确认云开发已开启用户名密码登录";
        } else if (err.error_description) {
            msg = err.error_description;
        }
        showLoginError(msg);
        
        // 恢复匿名登录态，以防后续切换到扫码登录时无法调用云函数
        try {
            await auth.signInAnonymously();
        } catch (e) {
            console.warn("恢复匿名登录失败", e);
        }
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
        stopQRCodePolling();
        // 1. 清除 SessionToken
        localStorage.removeItem('admin_session_token');
        
        // 2. 清除云开发原生登录态
        // auth is global
        await auth.signOut();
        console.log("已成功退出登录");
        
        // 3. 刷新页面，重新显示登录框
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
                <button class="btn-sm" style="background:var(--warning); color:#000; font-weight:600; padding:8px 16px;" onclick="handleBatchAutoSettle()">
                    ⏰ 一键结算超时房间（>5天）
                </button>
            </div>
            <div class="data-table-container">
                <table>
                    <thead>
                        <tr>
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
        
        // 绑定到全局
        window.handleSettleRoom = handleSettleRoom;
        window.handleDeleteRoom = handleDeleteRoom;
        window.handleBatchAutoSettle = handleBatchAutoSettle;
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

// 渲染玩家列表
window.renderPlayers = renderPlayers;
async function renderPlayers(page = 1) {
    try {
        currentPagePlayers = page;
        if (page === 1) {
            const countRes = await api.getCount('Players');
            totalPlayers = countRes.total || 0;
        }
        
        const skip = (page - 1) * PAGE_SIZE_PLAYERS;
        const res = await api.getList('Players', PAGE_SIZE_PLAYERS, skip);
        const players = res.data || [];

        if (players.length === 0) {
            contentArea.innerHTML = '<div class="loading-spinner">📭 暂无玩家数据</div>';
            return;
        }
        
        let html = `
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
            const key = p.nickname || '未知玩家';
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
                    <td>${hasMultiple ? '-' : (group.instances[0].is_host ? '👑 房主' : '👤 玩家')}</td>
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
                            <td style="color:var(--text-dim); font-size:13px;">房间对局记录</td>
                            <td><code>${player.room_code || '未知'}</code></td>
                            <td style="font-weight:700; color:${player.current_score >= 0 ? 'var(--success)' : 'var(--danger)'}">
                                ${player.current_score}
                            </td>
                            <td>${player.is_host ? '👑 房主' : '👤 玩家'}</td>
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
