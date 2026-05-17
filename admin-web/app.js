const ENV_ID = 'cloud1-d2gpq0fat0dd3c17f'; // 你的环境 ID

// 初始化云开发
const app = cloudbase.init({
    env: ENV_ID
});
const db = app.database();
const _ = db.command;

// 状态管理
let currentTab = 'dashboard';
let editingPlayerId = null;

// 页面元素
const contentArea = document.getElementById('content-area');
const tabTitle = document.getElementById('tab-title');
const envIdDisplay = document.getElementById('env-id');
const modal = document.getElementById('modal-overlay');

// 初始化
async function init() {
    envIdDisplay.innerText = ENV_ID;
    setupEventListeners();
    
    try {
        // 1. 必须先进行匿名登录才能访问数据库
        const auth = app.auth();
        await auth.anonymousAuthProvider().signIn();
        console.log("登录成功");
        
        // 2. 登录成功后再加载数据
        loadTab('dashboard');
    } catch (err) {
        console.error("初始化失败", err);
        contentArea.innerHTML = `
            <div class="error-box">
                <h3>🚫 访问受阻</h3>
                <p>${err.message}</p>
                <ul style="text-align:left; margin-top:10px; font-size:13px; color:var(--text-dim);">
                    <li>请检查云开发控制台是否开启了<b>“匿名登录”</b>（在“身份认证”->“登录方式”中）</li>
                    <li>请确保已将当前域名添加到<b>“Web 安全域名”</b>白名单中</li>
                </ul>
            </div>
        `;
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
        const roomsCount = await db.collection('Rooms').count();
        const playersCount = await db.collection('Players').count();
        const roundsCount = await db.collection('Rounds').count();

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
async function renderRooms() {
    try {
        const res = await db.collection('Rooms').limit(20).get();
        const rooms = res.data || [];
        
        if (rooms.length === 0) {
            contentArea.innerHTML = '<div class="loading-spinner">📭 暂无房间数据</div>';
            return;
        }

        let html = `
            <div class="data-table-container">
                <table>
                    <thead>
                        <tr>
                            <th>房间号</th>
                            <th>状态</th>
                            <th>当前台面费</th>
                            <th>创建时间</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        rooms.forEach(room => {
            html += `
                <tr>
                    <td><code>${room.room_code || 'N/A'}</code></td>
                    <td>${room.is_closed ? '🔴 已关闭' : '🟢 活跃中'}</td>
                    <td>${room.total_table_fee || 0}</td>
                    <td>${room.create_time ? new Date(room.create_time).toLocaleString() : '未知'}</td>
                </tr>
            `;
        });
        
        html += '</tbody></table></div>';
        contentArea.innerHTML = html;
    } catch (err) {
        console.error(err);
        contentArea.innerHTML = `<div class="error">加载失败: ${err.message}</div>`;
    }
}

// 渲染玩家列表
async function renderPlayers() {
    try {
        const res = await db.collection('Players').limit(50).get();
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
                            <th>当前分数</th>
                            <th>角色</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        players.forEach(player => {
            html += `
                <tr>
                    <td><img src="${player.avatar}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;" onerror="this.src='https://mmbiz.qpic.cn/mmbiz_png/icTdbqWNOwNRna42FI242Lcia07xvkWModszK68mKzVnI6zXk7Sdl7n1icA2Ebicic4icib4X0kicqG4nBVzNszM1EicicHA/640?wx_fmt=png'"></td>
                    <td>${player.nick_name || '未知玩家'}</td>
                    <td style="font-weight:700; color:${player.current_score >= 0 ? 'var(--success)' : 'var(--danger)'}">
                        ${player.current_score}
                    </td>
                    <td>${player.is_host ? '👑 房主' : '👤 玩家'}</td>
                    <td>
                        <button class="btn-sm" onclick="openEditModal('${player._id}', '${player.nick_name}', ${player.current_score})">修正</button>
                    </td>
                </tr>
            `;
        });
        
        html += '</tbody></table></div>';
        contentArea.innerHTML = html;
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

        await db.collection('Players').doc(editingPlayerId).update({
            current_score: newScore,
            update_time: db.serverDate()
        });

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
