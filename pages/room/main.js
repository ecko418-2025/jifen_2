const db = wx.cloud.database()
const _ = db.command

Page({
  data: {
    roomId: '',
    roomCode: '',
    players: [],
    rounds: [],
    currentTab: 'main',
    batchScores: {},
    otherPlayers: [],
    myPlayerId: '',
    tableFee: 0,
    showSettle: false,
    unitAmount: wx.getStorageSync('unitAmount') || 50,
    historyScrollTop: 0,
    showQRModal: false,
    roomQRCode: '',
    myPreviewDelta: 0,
    showInputModal: false,
    inputModalTitle: '',
    inputModalPlaceholder: '',
    inputModalValue: '',
    inputModalType: 'number',
    isHost: false,
    roomStatus: 'active'
  },

  async onLoad(options) {
    const roomId = options.id || options.roomId;
    if (!roomId) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      return;
    }
    this.setData({ roomId });
    
    wx.showLoading({ title: '安全连接中...', mask: true });
    
    let retryCount = 0;
    const maxRetries = 3;

    const doInit = async () => {
      try {
        // 1. 先确保登录状态
        const loginRes = await wx.cloud.callFunction({ 
          name: 'room-manager', 
          data: { action: 'getOpenid' },
          timeout: 60000
        });
        this.myOpenid = loginRes.result.openid;
        
        // 2. 获取房间基础信息
        await this.fetchRoomInfo(roomId);
        
        // 3. 核心修复：延迟并按顺序启动监听器，降低 WS 登录压力
        setTimeout(() => {
          this.initWatchSequence(roomId);
          wx.hideLoading();
        }, 800); 

      } catch (e) {
        console.error(`初始化失败:`, e);
        if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(() => doInit(), 2000);
        } else {
          wx.hideLoading();
          wx.showModal({
            title: '连接异常',
            content: '网络波动导致无法连接，请尝试重新进入',
            showCancel: false
          });
        }
      }
    };

    doInit();
  },

  // 下拉刷新逻辑
  onPullDownRefresh() {
    this.refreshRounds(true).then(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '记录已更新', icon: 'none' });
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 点击历史按钮逻辑：刷新并滚动到最下方
  scrollToHistory() {
    wx.showLoading({ title: '刷新中' });
    this.refreshRounds(true).then(() => {
      wx.hideLoading();
      this.setData({ historyScrollTop: 99999 }); // 滚动到最底部
      wx.showToast({ title: '已更新', icon: 'none' });
    });
  },

  async fetchRoomInfo(roomId) {
    const res = await db.collection('Rooms').doc(roomId).get();
    const data = res.data;
    this.setData({ 
      roomCode: data.room_code, 
      tableFee: Number(data.table_fee || 0),
      roomQRCode: data.qr_code_url || '',
      isHost: data.host_id === this.myOpenid,
      roomStatus: data.status || 'active'
    });
  },

  // 极致并发优化：回归单监听器方案，通过智能比对分数变化来触发局部刷新
  // 这种方案可以将连接数消耗降低 66%，完美支持基础版环境下的 10-18 人并发
  async initWatchSequence(roomId) {
    if (!roomId || !this.myOpenid) return;
    this.closeWatchers();
    
    const that = this;
    const myLocalNickname = wx.getStorageSync('nickname');

    this.playerWatcher = db.collection('Players')
      .where({ room_id: roomId })
      .watch({
        onChange: (snapshot) => {
          // 彻底修复：只提取纯数据字段，避免将复杂的数据库原始对象塞入 setData
          // 原始对象包含内部循环引用，是导致“depth 38”和“渲染层错误”的罪魁祸首
          const players = snapshot.docs.map(doc => {
            const data = typeof doc.data === 'function' ? doc.data() : doc;
            return {
              _id: data._id,
              user_id: data.user_id,
              nickname: data.nickname || '未知用户',
              avatar: data.avatar || '',
              current_score: Number(data.current_score || 0),
              is_kicked: !!data.is_kicked,
              is_me: (data.user_id && data.user_id === that.myOpenid) || (data.nickname === myLocalNickname)
            };
          });

          const scoreFingerprint = players
            .filter(p => p.current_score !== 0)
            .map(p => `${p._id}:${p.current_score}`)
            .sort()
            .join('|');

          // 如果指纹变了，说明有人提交了账目，此时才去刷新流水和台面费
          if (this.lastScoreFingerprint !== undefined && this.lastScoreFingerprint !== scoreFingerprint) {
            console.log('检测到分数变动，同步流水数据...');
            that.refreshRounds();
          }
          this.lastScoreFingerprint = scoreFingerprint;

          that.setData({ players });
          
          // 核心修复：当玩家列表变动（如有人被踢）时，实时更新快捷记账列表
          if (that.data.currentTab === 'expense' || that.data.currentTab === 'income') {
            const others = players.filter(p => !p.is_me && !p.is_kicked);
            that.setData({ otherPlayers: others });
          }
          
          const me = players.find(p => p.is_me);
          if (me) {
            that.setData({ myPlayerId: me._id });
          } else {
            that.autoJoin();
          }
        },
        onError: (err) => {
          console.error('Players watch error', err);
          if (err.errCode === -402002) that.retryWatch(roomId);
        }
      });

    // 初始进入时强制拉取一次
    this.refreshRounds(true);
  },

  // 关闭所有监听器
  closeWatchers() {
    if (this.playerWatcher) this.playerWatcher.close();
    if (this.roundWatcher) this.roundWatcher.close();
    if (this.roomWatcher) this.roomWatcher.close();
  },

  async refreshRounds(includePlayers = false) {
    // 增加简单的防抖，避免瞬间多次触发
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const promises = [
        wx.cloud.callFunction({
          name: 'room-manager',
          data: { action: 'getRounds', data: { room_id: this.data.roomId } }
        }),
        db.collection('Rooms').doc(this.data.roomId).get()
      ];
      
      if (includePlayers) {
        promises.push(db.collection('Players').where({ room_id: this.data.roomId }).get());
      }

      const results = await Promise.all(promises);
      const roundsRes = results[0].result ? results[0].result.rounds : [];
      const roomRes = results[1];
      
      this.processRounds(roundsRes);
      this.setData({ tableFee: Number(roomRes.data.table_fee || 0) });

      if (includePlayers && results[2]) {
        const playerRes = results[2];
        const myLocalNickname = wx.getStorageSync('nickname');
        const players = playerRes.data.map(data => ({
          _id: data._id,
          user_id: data.user_id,
          nickname: data.nickname || '未知用户',
          avatar: data.avatar || '',
          current_score: Number(data.current_score || 0),
          is_kicked: !!data.is_kicked,
          is_me: (data.user_id && data.user_id === this.myOpenid) || (data.nickname === myLocalNickname)
        }));
        this.setData({ players });
        const me = players.find(p => p.is_me);
        if (me) this.setData({ myPlayerId: me._id });
      }
    } catch (e) {
      console.error('刷新失败', e);
    } finally {
      setTimeout(() => { this._refreshing = false; }, 1000);
    }
  },

  processRounds(input) {
    if (!input) return;
    let docs = [];
    if (Array.isArray(input)) {
      docs = input;
    } else {
      docs = input.docs || (Array.isArray(input.data) ? input.data : (input.data ? [input.data] : []));
    }
    const players = this.data.players || [];
    if (players.length === 0 || docs.length === 0) return;

    const groupedRounds = [];
    docs.forEach(doc => {
      const data = doc.data ? doc.data() : doc;
      if (!data.scores) return;

      const date = data.created_at ? new Date(data.created_at) : new Date();
      const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      const timeKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()} ${timeStr}`;
      
      const recordDetails = players.map(p => {
        const val = Number(data.scores[p._id] || 0);
        if (val === 0) return null;
        return {
          name: p.nickname,
          text: `${val > 0 ? '+' : ''}${val}`,
          type: val > 0 ? 'pos' : (val < 0 ? 'neg' : 'zero')
        };
      }).filter(d => d !== null);

      const tableDelta = Number(data.table_fee_delta || 0);
      if (tableDelta !== 0) {
        recordDetails.push({ name: '台面', text: `+${tableDelta}`, type: 'table' });
      }

      const existing = groupedRounds.find(r => r.groupKey === timeKey);
      if (existing) {
        existing.entries.push(recordDetails);
      } else {
        groupedRounds.push({ groupKey: timeKey, time_str: timeStr, entries: [recordDetails] });
      }
    });

    this.setData({ rounds: groupedRounds });
  },

  retryWatch(roomId) {
    if (this._retrying) return;
    this._retrying = true;
    setTimeout(() => {
      if (this.data.roomId === roomId) {
        console.log('尝试恢复安全连接...');
        this.initWatchSequence(roomId);
      }
      this._retrying = false;
    }, 8000); // 延长重连间隔，避免频繁 login fail
  },

  closeWatchers() {
    try {
      if (this.roomWatcher) this.roomWatcher.close();
      if (this.playerWatcher) this.playerWatcher.close();
      if (this.roundWatcher) this.roundWatcher.close();
    } catch (e) {
      console.warn('清理连接失败', e);
    }
  },

  async showQR() {
    this.setData({ showQRModal: true });
    if (this.data.roomQRCode) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'getRoomQR', data: { room_id: this.data.roomId } }
      });
      if (res.result.qrCodeUrl) this.setData({ roomQRCode: res.result.qrCodeUrl });
    } catch (e) { console.error('二维码生成失败', e); }
  },

  hideQR() { this.setData({ showQRModal: false }); },

  onPlayerClick(e) {
    const player = e.currentTarget.dataset.player;
    if (!player) return;
    
    // 如果是自己且不是房主，不处理
    if (player.is_me && !this.data.isHost) return;
    
    // 如果是房主点击（包括点击自己），弹出操作菜单
    if (this.data.isHost) {
      const isSelf = player.is_me;
      const isKicked = player.is_kicked;
      
      let itemList = [];
      if (isKicked) {
        itemList = ['恢复进入房间'];
      } else if (isSelf) {
        itemList = ['踢出房间(退出)'];
      } else {
        itemList = ['记一笔账', '踢出房间'];
      }

      wx.showActionSheet({
        itemList: itemList,
        success: (res) => {
          if (isKicked) {
            if (res.tapIndex === 0) this.restorePlayer(player);
          } else if (isSelf) {
            if (res.tapIndex === 0) this.kickPlayer(player);
          } else {
            if (res.tapIndex === 0) this.showPlayerScoreInput(player);
            else if (res.tapIndex === 1) this.kickPlayer(player);
          }
        },
        fail: (err) => {
          console.log('ActionSheet取消', err);
        }
      });
    } else {
      if (player.is_me) return;
      this.showPlayerScoreInput(player);
    }
  },

  showPlayerScoreInput(player) {
    this.setData({
      showInputModal: true,
      inputModalPrefix: '支出给',
      inputModalName: player.nickname,
      inputModalPlaceholder: '请输入支出金额',
      inputModalValue: '',
      inputModalType: 'number',
      inputModalAction: 'player_score',
      inputModalTargetId: player._id
    });
  },

  async restorePlayer(player) {
    wx.showLoading({ title: '正在恢复', mask: true });
    try {
      await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'restore', data: { room_id: this.data.roomId, player_id: player._id } }
      });
      wx.hideLoading();
      wx.showToast({ title: '已恢复' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  async kickPlayer(player) {
    wx.showModal({
      title: '确认踢出',
      content: `确定要将玩家 ${player.nickname} 踢出房间吗？（其余额将保留以供核对）`,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在踢出', mask: true });
          try {
            await wx.cloud.callFunction({
              name: 'room-manager',
              data: { action: 'kick', data: { room_id: this.data.roomId, player_id: player._id } }
            });
            wx.hideLoading();
            wx.showToast({ title: '已踢出' });
            // 如果踢出的是自己，跳转回首页
            if (player.is_me) {
              setTimeout(() => { wx.reLaunch({ url: '/pages/index/index' }); }, 1500);
            }
          } catch (e) {
            wx.hideLoading();
            wx.showToast({ title: '操作失败', icon: 'none' });
          }
        }
      }
    });
  },

  onTableClick() {
    if (!this.data.myPlayerId) return;
    this.setData({
      showInputModal: true,
      inputModalPrefix: '',
      inputModalName: '缴纳台面费',
      inputModalPlaceholder: '请输入台面费金额',
      inputModalValue: '',
      inputModalType: 'number',
      inputModalAction: 'table_fee'
    });
  },

  onModalInput(e) {
    this.setData({ inputModalValue: e.detail.value });
  },

  onModalCancel() {
    this.setData({ showInputModal: false });
  },

  async onModalConfirm() {
    const amount = parseInt(this.data.inputModalValue);
    if (!amount || amount <= 0) {
      this.setData({ showInputModal: false });
      return;
    }
    
    const action = this.data.inputModalAction;
    const targetId = this.data.inputModalTargetId;
    
    this.setData({ showInputModal: false });
    wx.showLoading({ title: '处理中', mask: true });
    
    try {
      let updateData = {};
      let tableDelta = 0;
      
      if (action === 'player_score') {
        updateData = { [targetId]: amount, [this.data.myPlayerId]: -amount };
      } else if (action === 'table_fee') {
        updateData = { [this.data.myPlayerId]: -amount };
        tableDelta = amount;
      }
      
      await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'submitRound', data: { room_id: this.data.roomId, scores: updateData, table_fee: tableDelta } }
      });
      
      wx.hideLoading();
      wx.showToast({ title: '记账成功' });
      this.setData({ historyScrollTop: 0 });
      this.refreshRounds(true);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '提交失败', icon: 'none' });
    }
  },

  async autoJoin() {
    if (this._joining || this._joinedOnce) return;
    this._joining = true;
    try {
      await wx.cloud.callFunction({
        name: 'room-manager',
        data: {
          action: 'join',
          data: {
            room_id: this.data.roomId,
            nickname: wx.getStorageSync('nickname') || '新玩家',
            avatar: wx.getStorageSync('avatarUrl') || ''
          }
        },
        timeout: 60000
      });
      this._joinedOnce = true;
    } catch (e) { console.error('自动加入失败', e); } finally { this._joining = false; }
  },

  goHome() { wx.reLaunch({ url: '/pages/index/index' }); },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === 'expense' || tab === 'income') {
      const others = this.data.players.filter(p => !p.is_me && !p.is_kicked);
      this.setData({ otherPlayers: others, batchScores: {} });
    }
    this.setData({ currentTab: tab, myPreviewDelta: 0 });
  },

  calculatePreview(batchScores) {
    let myNetChange = 0;
    const isExpense = this.data.currentTab === 'expense';
    
    Object.keys(batchScores).forEach(pid => {
      const amount = parseInt(batchScores[pid]);
      if (!amount || amount <= 0) return;
      if (pid === 'table') {
        myNetChange -= amount;
      } else {
        if (isExpense) myNetChange -= amount;
        else myNetChange += amount;
      }
    });

    this.setData({ 
      batchScores,
      myPreviewDelta: myNetChange
    });
  },

  onBatchInput(e) {
    const { id } = e.currentTarget.dataset;
    const val = e.detail.value;
    const batchScores = { ...this.data.batchScores, [id]: val };
    this.calculatePreview(batchScores);
  },

  addTableTen() {
    const current = parseInt(this.data.batchScores['table'] || 0);
    const newScores = { ...this.data.batchScores, table: current + 10 };
    this.calculatePreview(newScores);
  },

  resetToZero(e) {
    const { id } = e.currentTarget.dataset;
    const newScores = { ...this.data.batchScores, [id]: '' };
    this.calculatePreview(newScores);
  },

  onUnitInput(e) {
    const val = e.detail.value;
    this.setData({ unitAmount: val });
    wx.setStorageSync('unitAmount', val);
  },

  applyMultiplier(e) {
    const m = parseInt(e.currentTarget.dataset.m);
    const unit = parseInt(this.data.unitAmount);
    if (!unit || unit <= 0) {
      wx.showToast({ title: '请先输入单份金额', icon: 'none' });
      return;
    }
    const newScores = { ...this.data.batchScores };
    const amountToAdd = unit * m;

    // 对所有其他玩家进行累加
    this.data.otherPlayers.forEach(p => {
      const current = parseInt(newScores[p._id] || 0);
      newScores[p._id] = current + amountToAdd;
    });

    this.calculatePreview(newScores);
  },

  async submitBatch() {
    if (!this.data.myPlayerId) return;
    const isExpense = this.data.currentTab === 'expense';
    const batch = this.data.batchScores;
    const updateData = {};
    let myNetChange = 0;
    let tableDelta = 0;

    Object.keys(batch).forEach(pid => {
      const amount = parseInt(batch[pid]);
      if (!amount || amount <= 0) return;
      if (pid === 'table') {
        tableDelta = amount;
        myNetChange -= amount;
      } else {
        if (isExpense) {
          updateData[pid] = amount;
          myNetChange -= amount;
        } else {
          updateData[pid] = -amount;
          myNetChange += amount;
        }
      }
    });

    if (myNetChange === 0 && tableDelta === 0) return;
    updateData[this.data.myPlayerId] = myNetChange;

    wx.showLoading({ title: '提交中', mask: true });
    try {
      await wx.cloud.callFunction({
        name: 'room-manager',
        data: {
          action: 'submitRound',
          data: { room_id: this.data.roomId, scores: updateData, table_fee: tableDelta }
        }
      });
      wx.hideLoading();
      wx.showToast({ title: '记账成功' });
      this.setData({ currentTab: 'main', batchScores: {}, historyScrollTop: 0 });
      this.refreshRounds(true);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '提交失败', icon: 'none' });
    }
  },

  showAddPlayer() {
    wx.showActionSheet({
      itemList: ['添加虚拟玩家', '发送邀请链接'],
      success: (res) => {
        if (res.tapIndex === 0) this.addVirtualPlayer();
        else wx.showToast({ title: '请点击右上角转发', icon: 'none' });
      }
    });
  },

  async addVirtualPlayer() {
    wx.showModal({
      title: '添加虚拟玩家',
      placeholderText: '请输入玩家昵称',
      editable: true,
      success: async (res) => {
        if (res.confirm && res.content) {
          wx.showLoading({ title: '添加中', mask: true });
          try {
            await wx.cloud.callFunction({
              name: 'room-manager',
              data: { action: 'addVirtual', data: { room_id: this.data.roomId, nickname: res.content } }
            });
            wx.hideLoading();
            wx.showToast({ title: '添加成功' });
          } catch (e) {
            wx.hideLoading();
            wx.showToast({ title: '添加失败', icon: 'none' });
          }
        }
      }
    });
  },

  onShareAppMessage() {
    return {
      title: `快加入我的牌局！房间号：${this.data.roomCode}`,
      path: `/pages/index/index?roomId=${this.data.roomId}`
    };
  },

  onShareTimeline() {
    return {
      title: `快加入我的牌局！房间号：${this.data.roomCode}`,
      query: `roomId=${this.data.roomId}`
    };
  },

  onEndGame() { this.setData({ showSettle: true }); },
  hideSettle() { this.setData({ showSettle: false }); },
  confirmEndGame() {
    wx.showModal({
      title: '确认退出',
      content: this.data.isHost ? '确认结算结果并结束房间吗？' : '确认结算结果并退出房间吗？',
      success: async (res) => {
        if (res.confirm) {
          if (!this.data.isHost) {
            wx.reLaunch({ url: '/pages/index/index' });
            return;
          }

          wx.showLoading({ title: '正在结算', mask: true });
          try {
            const closeRes = await wx.cloud.callFunction({
              name: 'room-manager',
              data: {
                action: 'closeRoom',
                data: { room_id: this.data.roomId }
              },
              timeout: 20000
            });
            if (!closeRes.result || closeRes.result.success !== true) {
              throw new Error((closeRes.result && (closeRes.result.error || closeRes.result.msg)) || '结算失败');
            }
            wx.hideLoading();
            wx.showToast({ title: '已结束房间' });
            setTimeout(() => {
              wx.reLaunch({ url: '/pages/index/index' });
            }, 800);
          } catch (e) {
            wx.hideLoading();
            wx.showModal({
              title: '结束失败',
              content: e.message || '网络异常，请重试',
              showCancel: false
            });
          }
        }
      }
    });
  },
  onHide() {
    this.closeWatchers();
  },

  onUnload() {
    this.closeWatchers();
  }
})
