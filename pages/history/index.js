Page({
  data: {
    rooms: [],
    loading: true
  },

  onLoad() {
    this.loadHistory()
  },

  onShow() {
    this.loadHistory()
  },

  async loadHistory() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'getAllRooms' },
        timeout: 20000
      })
      this.setData({ rooms: res.result.rooms || [] })
    } catch (e) {
      console.error('历史房间加载失败', e)
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  enterRoom(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/room/main?id=${id}` })
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
            wx.showToast({ title: '已移除，统计数据仍保留' })
            this.loadHistory()
          } catch (e) {
            wx.hideLoading()
            wx.showToast({ title: '移除失败', icon: 'none' })
          }
        }
      }
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
