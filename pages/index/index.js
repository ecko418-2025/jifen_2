const db = wx.cloud.database()
const _ = db.command

Page({
  data: {
    userInfo: {
      nickname: wx.getStorageSync('nickname') || '',
      avatarUrl: wx.getStorageSync('avatarUrl') || '',
      total_points: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      rank: '较远',
      totalGames: 0,
      maxScore: 0,
      minScore: 0,
      avgScore: 0
    },
    activeRooms: [],
    loading: false,
    showStatsDetail: false,
    inputRoomCode: ''
  },
  onLoad(options) {
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    })

    // 需求①：处理分享链接中携带的 roomId，自动跳转进房间
    if (options.roomId) {
      wx.navigateTo({ url: `/pages/room/main?id=${options.roomId}` })
    } else if (options.scene) {
      // 处理小程序码扫码进入
      const sceneVal = decodeURIComponent(options.scene)
      if (sceneVal.startsWith('L_')) {
        // 如果是以 L_ 开头，说明是后台登录扫码，跳转到授权登录页
        wx.navigateTo({ url: `/pages/admin/login?ticket=${sceneVal}` })
      } else {
        // 否则认为是普通的 roomId 进入房间
        wx.navigateTo({ url: `/pages/room/main?id=${sceneVal}` })
      }
    }

    this.refreshHomeData()
  },


  onShow() {
    this.setData({
      'userInfo.nickname': wx.getStorageSync('nickname') || '',
      'userInfo.avatarUrl': wx.getStorageSync('avatarUrl') || ''
    })
    this.refreshHomeData()
  },

  async refreshHomeData() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'getHomeData' },
        timeout: 30000
      })
      if (!res.result || !res.result.stats) {
        console.warn('首页数据获取失败')
        return
      }
      const { stats, activeRooms } = res.result
      this.setData({
        'userInfo.wins': stats.wins,
        'userInfo.losses': stats.losses,
        'userInfo.winRate': stats.winRate,
        'userInfo.totalPoints': stats.totalPoints,
        'userInfo.rank': stats.rank,
        'userInfo.totalGames': stats.totalGames,
        'userInfo.maxScore': stats.maxScore,
        'userInfo.minScore': stats.minScore,
        'userInfo.avgScore': stats.avgScore,
        activeRooms: activeRooms
      })
    } catch (e) {
      console.error('刷新首页数据失败', e)
    } finally {
      this.setData({ loading: false })
    }
  },

  showHistoryStats() {
    this.setData({ showStatsDetail: true })
  },

  hideHistoryStats() {
    this.setData({ showStatsDetail: false })
  },

  onLongPressRoom(e) {
    const roomId = e.currentTarget.dataset.id
    wx.showActionSheet({
      itemList: ['不再显示此房间'],
      itemColor: '#ff4757',
      success: async (res) => {
        if (res.tapIndex === 0) {
          wx.showLoading({ title: '正在移除', mask: true })
          try {
            await wx.cloud.callFunction({
              name: 'room-manager',
              data: { action: 'hideRoom', data: { room_id: roomId } }
            })
            wx.hideLoading()
            wx.showToast({ title: '已移除显示' })
            this.refreshHomeData()
          } catch (e) {
            wx.hideLoading()
            wx.showToast({ title: '移除失败', icon: 'none' })
          }
        }
      }
    })
  },

  // 需求：头像自动剪裁、压缩并上传云存储
  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail;
    wx.showLoading({ title: '正在处理头像...', mask: true });

    try {
      // 1. 压缩并剪裁图片
      const processedPath = await this.processImage(avatarUrl);
      
      // 2. 上传至云存储
      const cloudPath = `avatars/${wx.getStorageSync('openid') || Date.now()}_${Math.random().toString(36).slice(-4)}.jpg`;
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: processedPath
      });
      
      const fileID = uploadRes.fileID;
      this.setData({ 'userInfo.avatarUrl': fileID });
      wx.setStorageSync('avatarUrl', fileID);

      // 3. 同步至所有历史房间
      await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'updateProfile', data: { avatar: fileID } },
        timeout: 15000
      });
      
      wx.hideLoading();
      wx.showToast({ title: '设置成功' });
    } catch (err) {
      console.error('头像处理失败', err);
      wx.hideLoading();
      wx.showToast({ title: '处理失败，请重试', icon: 'none' });
    }
  },

  // 使用 Canvas 2D 接口进行自动中心剪裁和缩放 (200x200)
  processImage(src) {
    return new Promise((resolve, reject) => {
      const query = wx.createSelectorQuery();
      query.select('#avatarCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res[0] || !res[0].node) {
            reject(new Error('未找到画布节点'));
            return;
          }
          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          const dpr = wx.getSystemInfoSync().pixelRatio;
          
          // 设置画布物理像素尺寸
          canvas.width = 200 * dpr;
          canvas.height = 200 * dpr;
          ctx.scale(dpr, dpr);

          const img = canvas.createImage();
          img.src = src;
          img.onload = () => {
            const { width, height } = img;
            const size = 200;
            let sx, sy, sSize;
            if (width > height) {
              sSize = height;
              sx = (width - height) / 2;
              sy = 0;
            } else {
              sSize = width;
              sx = 0;
              sy = (height - width) / 2;
            }
            
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, size, size);
            
            wx.canvasToTempFilePath({
              canvas,
              destWidth: size,
              destHeight: size,
              fileType: 'jpg',
              quality: 0.8,
              success: (res) => resolve(res.tempFilePath),
              fail: (err) => reject(err)
            });
          };
          img.onerror = (err) => reject(err);
        });
    });
  },

  // 需求④：更换昵称后同步云端所有 Players 记录
  async onNicknameBlur(e) {
    const nickname = e.detail.value
    if (!nickname) return
    this.setData({ 'userInfo.nickname': nickname })
    wx.setStorageSync('nickname', nickname)
    try {
      await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'updateProfile', data: { nickname } },
        timeout: 15000
      })
    } catch (err) {
      console.warn('昵称同步失败', err)
    }
  },



  async goToCreate() {
    const nickname = this.data.userInfo.nickname || '新玩家'
    const avatar = this.data.userInfo.avatarUrl || ''
    
    wx.showLoading({ title: '正在开启牌局', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: {
          action: 'create',
          data: {
            nickname: nickname,
            avatar: avatar,
            rules: { baseScore: 0 }
          }
        }
      })
      const { roomId } = res.result
      wx.navigateTo({ url: `/pages/room/main?id=${roomId}` })
    } catch (e) {
      console.error('开局失败', e)
      wx.showModal({ title: '开局失败', content: '网络连接超时，请重试', showCancel: false })
    } finally {
      wx.hideLoading()
    }
  },

  joinByScan() {
    wx.scanCode({
      success: (res) => {
        console.log('扫码原始结果', res)
        
        // 优先处理小程序码 (Mini Program Code)
        if (res.path) {
          const path = decodeURIComponent(res.path)
          if (path.includes('scene=')) {
            const scene = path.split('scene=')[1].split('&')[0]
            wx.navigateTo({ url: `/pages/room/main?id=${scene}` })
            return
          }
        }

        // 处理普通二维码或纯文本结果
        const val = res.result
        if (!val) return
        
        if (val.startsWith('L_')) {
          // 如果是后台登录普通二维码，跳转到授权登录页
          wx.navigateTo({ url: `/pages/admin/login?ticket=${val}` })
        } else if (/^\d{6}$/.test(val)) {
          // 如果是 6 位纯数字，按房间号进入
          this.enterByCode(val)
        } else {
          // 否则尝试作为 roomId 直接跳转
          wx.navigateTo({ url: `/pages/room/main?id=${val}` })
        }
      },
      fail: (err) => {
        console.warn('扫码已取消或失败', err)
      }
    })
  },

  async enterByCode(code) {
    if (!code) return
    wx.showLoading({ title: '正在搜索', mask: true })
    try {
      const res = await db.collection('Rooms').where({ room_code: code }).get()
      wx.hideLoading()
      if (res.data.length > 0) {
        wx.navigateTo({ url: `/pages/room/main?id=${res.data[0]._id}` })
        this.setData({ inputRoomCode: '' }) // 成功后清空
      } else {
        wx.showToast({ title: '房间号不存在', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '搜索失败', icon: 'none' })
    }
  },

  onInputRoomCode(e) {
    this.setData({ inputRoomCode: e.detail.value })
  },

  enterByCodeManual() {
    const code = this.data.inputRoomCode
    if (!code || code.length !== 6) {
      wx.showToast({ title: '请输入6位数字', icon: 'none' })
      return
    }
    this.enterByCode(code)
  },

  enterRoom(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/room/main?id=${id}` })
  },

  // 需求③：跳转到历史房间列表页
  goToAllHistory() {
    wx.navigateTo({ url: '/pages/history/index' })
  },

  goToRank() {
    wx.showToast({ title: '排行榜开发中', icon: 'none' })
  },

  onShareAppMessage() {
    return {
      title: '牌局积分助手，线下打牌记账更清楚',
      path: '/pages/index/index'
    }
  },

  onShareTimeline() {
    return {
      title: '牌局积分助手，线下打牌记账更清楚',
      query: ''
    }
  }
})
