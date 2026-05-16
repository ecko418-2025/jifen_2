const db = wx.cloud.database()
const _ = db.command

Page({
  data: {
    rankList: []
  },

  async onLoad() {
    wx.showLoading({ title: '加载中' });
    await this.fetchRankData();
    wx.hideLoading();
  },

  async fetchRankData() {
    try {
      const loginRes = await wx.cloud.callFunction({ name: 'room-manager', data: { action: 'getOpenid' } });
      const myOpenid = loginRes.result.openid;

      // 1. 获取我参加过的所有房间 ID
      const myRoomsRes = await db.collection('Players')
        .where({ user_id: myOpenid })
        .field({ room_id: true })
        .get();
      
      const roomIds = [...new Set(myRoomsRes.data.map(p => p.room_id))];

      if (roomIds.length === 0) return;

      // 2. 获取这些房间里的所有玩家记录
      const allPlayersRes = await db.collection('Players')
        .where({ room_id: _.in(roomIds) })
        .get();

      // 3. 按昵称/OpenID 进行汇总统计
      const statsMap = {};
      allPlayersRes.data.forEach(p => {
        const key = p.user_id || `virtual_${p.nickname}`;
        if (!statsMap[key]) {
          statsMap[key] = {
            nickname: p.nickname,
            avatar: p.avatar,
            total_points: 0,
            is_me: p.user_id === myOpenid
          };
        }
        statsMap[key].total_points += p.current_score;
      });

      // 4. 转为数组并排序
      const rankList = Object.values(statsMap).sort((a, b) => b.total_points - a.total_points);

      this.setData({ rankList });
    } catch (e) {
      console.error('获取排行榜失败', e);
    }
  },

  onShareAppMessage() {
    return {
      title: '狼管家记账工具 - 谁才是真的狼王？',
      path: '/pages/index/index'
    };
  }
})
