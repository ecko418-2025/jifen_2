App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloud1-d2gpq0fat0dd3c17f', 
        traceUser: true,
      })
    }
    wx.setKeepScreenOn({ keepScreenOn: true })
  },
  globalData: {
    userInfo: null
  }
})
