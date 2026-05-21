Page({
  data: {
    rooms: [],
    loading: true,
    showTrend: false,
    trendRoomCode: '',
    trendFinalScore: 0,
    trendMaxDelta: 0
  },

  async onLoad() {
    await this.ensureOpenid();
    this.loadHistory()
  },

  onShow() {
    this.loadHistory()
  },

  async ensureOpenid() {
    if (this.myOpenid) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'getOpenid' }
      });
      this.myOpenid = res.result.openid;
    } catch (e) {
      console.error('获取身份失败', e);
    }
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

  async showRoomTrend(e) {
    const { id, code } = e.currentTarget.dataset;
    wx.showLoading({ title: '加载数据...', mask: true });

    try {
      // 1. 确保有 OpenID
      await this.ensureOpenid();
      if (!this.myOpenid) throw new Error('身份识别失败，请检查网络');

      // 2. 获取该房间所有流水记录
      const res = await wx.cloud.callFunction({
        name: 'room-manager',
        data: { action: 'getRounds', data: { room_id: id } }
      });

      if (!res.result || !res.result.success) throw new Error('数据拉取失败');
      
      const rawRounds = res.result.rounds || [];
      if (rawRounds.length === 0) {
        wx.showToast({ title: '该房间暂无变动记录', icon: 'none' });
        return;
      }

      // 3. 查找我当前用户的 Player 记录 (改用 user_id 匹配，更稳定)
      const db = wx.cloud.database();
      const playerRes = await db.collection('Players').where({ 
        room_id: id,
        user_id: this.myOpenid
      }).limit(1).get();

      if (playerRes.data.length === 0) throw new Error('未找到您的玩家记录');
      const myPlayerId = playerRes.data[0]._id;

      // 4. 计算趋势序列 (正序计算)
      const history = [];
      let currentTotal = 0;
      let maxDelta = 0;

      [...rawRounds].reverse().forEach(round => {
        const val = parseInt(round.scores[myPlayerId] || 0);
        if (val !== 0) {
          currentTotal += val;
          if (Math.abs(val) > maxDelta) maxDelta = Math.abs(val);
          history.push(currentTotal);
        }
      });

      if (history.length === 0) {
        wx.showToast({ title: '暂无变动数据', icon: 'none' });
        return;
      }

      this.setData({
        showTrend: true,
        trendRoomCode: code,
        trendFinalScore: currentTotal,
        trendMaxDelta: maxDelta
      });

      wx.hideLoading();

      // 延迟绘图
      setTimeout(() => {
        this.drawTrendCanvas(history);
      }, 300);

    } catch (err) {
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: err.message || '加载走势失败', icon: 'none' });
    }
  },

  hideTrendModal() {
    this.setData({ showTrend: false });
  },

  drawTrendCanvas(data) {
    const query = wx.createSelectorQuery();
    query.select('#trendCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res[0]) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const width = res[0].width;
        const height = res[0].height;

        const dpr = wx.getSystemInfoSync().pixelRatio;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        const padding = 40;
        const chartWidth = width - padding * 2;
        const chartHeight = height - padding * 2;

        const minScore = Math.min(0, ...data);
        const maxScore = Math.max(0, ...data);
        const range = (maxScore - minScore) || 100;

        const getX = (i) => padding + (i / (data.length > 1 ? data.length - 1 : 1)) * chartWidth;
        const getY = (v) => padding + chartHeight - ((v - minScore) / range) * chartHeight;

        ctx.strokeStyle = '#f0f0f0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const zeroY = getY(0);
        ctx.moveTo(padding, zeroY);
        ctx.lineTo(width - padding, zeroY);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = '#6c63ff';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        data.forEach((val, i) => {
          if (i === 0) ctx.moveTo(getX(i), getY(val));
          else ctx.lineTo(getX(i), getY(val));
        });
        ctx.stroke();

        ctx.lineTo(getX(data.length - 1), zeroY);
        ctx.lineTo(getX(0), zeroY);
        const gradient = ctx.createLinearGradient(0, padding, 0, height - padding);
        gradient.addColorStop(0, 'rgba(108, 99, 255, 0.2)');
        gradient.addColorStop(1, 'rgba(108, 99, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.fill();

        const maxVal = Math.max(...data);
        const minVal = Math.min(...data);
        const maxIndex = data.indexOf(maxVal);
        const minIndex = data.indexOf(minVal);

        data.forEach((val, i) => {
          ctx.beginPath();
          ctx.fillStyle = val >= 0 ? '#e74c3c' : '#27ae60';
          ctx.arc(getX(i), getY(val), 4, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.font = 'bold 12px sans-serif';
          if (i === data.length - 1) {
            ctx.fillStyle = '#333';
            ctx.fillText(val, getX(i) - 10, getY(val) - 10);
          } else if (i === maxIndex && val !== 0) {
            ctx.fillStyle = '#e74c3c';
            ctx.fillText('Max ' + val, getX(i) - 20, getY(val) - 10);
          } else if (i === minIndex && val !== 0) {
            ctx.fillStyle = '#27ae60';
            ctx.fillText('Min ' + val, getX(i) - 20, getY(val) + 18);
          }
        });
      });
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
  },

  onShareAppMessage() {
    return {
      title: '狼管家记账工具 - 历史对局记录',
      path: '/pages/index/index'
    }
  }
})
