const app = getApp();

Page({
  data: {
    ticket: '',
    loading: true,
    submitting: false,
    nickname: ''
  },

  onLoad(options) {
    if (!options.ticket) {
      wx.showModal({
        title: '错误',
        content: '缺少登录凭证，请重新扫码',
        showCancel: false,
        success: () => wx.reLaunch({ url: '/pages/index/index' })
      });
      return;
    }

    this.setData({ ticket: options.ticket });
    this.checkAdminPrivilege();
  },

  // 验证当前用户是否有管理员权限
  async checkAdminPrivilege() {
    try {
      // 1. 调用云函数验证并获取用户信息
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: {
          action: 'checkAdminStatus'
        }
      });

      if (res.result && res.result.success && res.result.isAdmin) {
        this.setData({
          loading: false,
          nickname: res.result.nickname || '管理员'
        });
      } else {
        wx.showModal({
          title: '拒绝访问',
          content: '您的微信账号不是系统管理员，无权授权登录后台',
          showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/index/index' })
        });
      }
    } catch (err) {
      console.error('验证管理员身份失败', err);
      wx.showModal({
        title: '验证失败',
        content: '网络错误，请稍后重试',
        showCancel: false,
        success: () => wx.reLaunch({ url: '/pages/index/index' })
      });
    }
  },

  // 确认授权
  async confirmAuth() {
    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: {
          action: 'adminAuthorizeTicket',
          ticket: this.data.ticket
        }
      });

      if (res.result && res.result.success) {
        wx.showToast({
          title: '授权成功',
          icon: 'success',
          duration: 2000
        });
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/index/index' });
        }, 1500);
      } else {
        wx.showModal({
          title: '授权失败',
          content: res.result.error || '未知错误，请重试',
          showCancel: false
        });
        this.setData({ submitting: false });
      }
    } catch (err) {
      console.error('授权提交失败', err);
      wx.showModal({
        title: '授权失败',
        content: '提交授权时发生网络错误',
        showCancel: false
      });
      this.setData({ submitting: false });
    }
  },

  // 取消授权
  cancelAuth() {
    wx.showToast({
      title: '已取消授权',
      icon: 'none'
    });
    setTimeout(() => {
      wx.reLaunch({ url: '/pages/index/index' });
    }, 1000);
  }
});
