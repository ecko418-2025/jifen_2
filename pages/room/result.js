const { calculateTransfers } = require('../../utils/settle');

Page({
  data: {
    players: [],
    winner: null,
    transfers: []
  },

  onLoad(options) {
    const eventChannel = this.getOpenerEventChannel();
    // 获取从主页面传来的最终分数数据
    eventChannel.on('acceptDataFromOpenerPage', (data) => {
      const playersForSettle = [...data.players];
      // 如果有台面费结余，将其作为虚拟收款方参与结算，以保证平账
      if (data.tableFee > 0) {
        playersForSettle.push({ 
          nickname: '台面 (结余)', 
          current_score: data.tableFee,
          is_virtual: true 
        });
      }
      
      const sorted = [...data.players].sort((a, b) => b.current_score - a.current_score);
      const transfers = calculateTransfers(playersForSettle);
      
      this.setData({
        players: sorted,
        winner: sorted[0],
        transfers: transfers,
        tableFee: data.tableFee
      });
    });
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  }
})
