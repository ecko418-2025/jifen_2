const { calculateTransfers } = require('../../utils/settle');

Page({
  data: {
    players: [],
    winner: null,
    transfers: [],
    showTrend: false,
    myCurrentScore: 0,
    myMaxDelta: 0
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
        tableFee: data.tableFee,
        // 保存原始数据用于走势图
        allRounds: data.rounds || [],
        allPlayers: data.players || []
      });
    });
  },

  showTrendModal() {
    const rounds = this.data.allRounds || [];
    const myNickname = wx.getStorageSync('nickname');
    
    // 计算趋势 (正序)
    const history = [];
    let currentTotal = 0;
    let maxDelta = 0;

    // 此时 rounds 是按创建时间倒序排的，我们要 reverse
    [...rounds].reverse().forEach(round => {
      // 在 result 页，我们需要根据昵称匹配，因为 myPlayerId 可能已经丢失上下文
      // 我们在 onLoad 里存了 allPlayers
      const me = this.data.allPlayers.find(p => p.nickname === myNickname);
      if (me) {
        const val = parseInt(round.scores[me._id] || 0);
        if (val !== 0) {
          currentTotal += val;
          if (Math.abs(val) > maxDelta) maxDelta = Math.abs(val);
          history.push(currentTotal);
        }
      }
    });

    if (history.length === 0) {
      wx.showToast({ title: '暂无变动数据', icon: 'none' });
      return;
    }

    this.setData({
      showTrend: true,
      myCurrentScore: currentTotal,
      myMaxDelta: maxDelta
    });

    setTimeout(() => {
      this.drawTrendCanvas(history);
    }, 300);
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

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  }
})
