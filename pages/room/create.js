Page({
  data: {
    nickname: wx.getStorageSync('nickname') || '',
    avatarUrl: wx.getStorageSync('avatarUrl') || '',
    baseScore: wx.getStorageSync('lastBaseScore') || 0,
    loading: false
  },

  onChooseAvatar(e) {
    const { avatarUrl } = e.detail;
    this.setData({ avatarUrl });
    wx.setStorageSync('avatarUrl', avatarUrl);
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  onNicknameBlur(e) {
    this.setData({ nickname: e.detail.value });
  },

  onBaseScoreInput(e) {
    this.setData({ baseScore: e.detail.value });
  },

  async onCreate() {
    if (!this.data.nickname) {
      return wx.showToast({ title: '请输入昵称', icon: 'none' });
    }
    this.setData({ loading: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: {
          action: 'create',
          data: {
            nickname: this.data.nickname,
            rules: { baseScore: this.data.baseScore }
          }
        }
      });
      
      const { roomId } = res.result;
      wx.setStorageSync('nickname', this.data.nickname);
      wx.setStorageSync('lastBaseScore', this.data.baseScore);
      wx.navigateTo({ url: `/pages/room/main?id=${roomId}` });
    } catch (e) {
      console.error('创建房间完整错误信息：', e);
      const errMsg = e.message || '未知错误';
      wx.showModal({
        title: '创建失败',
        content: `原因：${errMsg}。请确认云函数已部署且数据库权限已开启。`,
        showCancel: false
      });
    } finally {
      this.setData({ loading: false });
    }
  }
})
