Page({
  data: {
    players: [],
    winner: null,
    tableFee: 0,
    isGeneratingReport: false,
    aiReport: ''
  },

  onLoad(options) {
    const eventChannel = this.getOpenerEventChannel();
    // 获取从主页面传来的最终分数数据
    eventChannel.on('acceptDataFromOpenerPage', (data) => {
      const sorted = [...data.players].sort((a, b) => b.current_score - a.current_score);

      this.setData({
        players: sorted,
        winner: sorted[0],
        tableFee: data.tableFee
      });

      // 触发 AI 生成战报
      this.generateAIReport(sorted, data.tableFee);
    });
  },

  async generateAIReport(players, tableFee) {
    this.setData({ isGeneratingReport: true, aiReport: '' });

    try {
      // 1. 拼接动态数据
      let dataStr = "本局数据：";
      players.forEach(p => {
        if (!p.is_virtual || p.nickname.indexOf('台面') === -1) {
           const action = p.current_score >= 0 ? '赢了' : '输了';
           dataStr += `[${p.nickname}]${action}${Math.abs(p.current_score)}，`;
        }
      });
      if (tableFee > 0) {
        dataStr += `大家凑的台面费共计：${tableFee}。`;
      }

      // 2. 设定 Prompt
      const systemPrompt = "你是一个资深牌友，很会阴阳怪气。请根据我提供的本局打牌得分数据，写一段80字左右的牌局总结。要求：重点夸奖赢家是赌神/雀神，狠狠调侃输得最惨的人；如果有台面费，顺便提一嘴这是大家的‘茶水钱/场地费’；语气要幽默、接地气，极具嘲讽拉满，适合发微信群。";

      // 3. 调用 AI 模型 (需确保基础库版本支持)
      if (!wx.cloud || !wx.cloud.extend || !wx.cloud.extend.AI) {
         throw new Error("当前基础库版本过低，不支持 AI 功能");
      }

      const model = wx.cloud.extend.AI.createModel("hunyuan-exp");
      const res = await model.generateText({
        model: "hunyuan-2.0-instruct-20251111",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: dataStr }
        ],
      });

      if (res && res.choices && res.choices.length > 0) {
        this.setData({ 
          aiReport: res.choices[0].message.content,
          isGeneratingReport: false 
        });
      } else {
        throw new Error("AI 返回数据异常");
      }
    } catch (e) {
      console.error("AI 战报生成失败:", e);
      this.setData({ 
        isGeneratingReport: false,
        aiReport: '' // 留空则显示错误提示
      });
    }
  },

  copyReport() {
    if (!this.data.aiReport) return;
    wx.setClipboardData({
      data: this.data.aiReport,
      success: () => {
        wx.showToast({ title: '已复制，快去群里嘲讽吧！', icon: 'none' });
      }
    });
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  }
})
