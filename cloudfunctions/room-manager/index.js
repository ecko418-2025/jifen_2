const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { action, data } = event
  const { OPENID } = cloud.getWXContext()

  switch (action) {

    // ─── 首页数据 ──────────────────────────────────────────────────────────
    case 'getHomeData': {
      try {
        // 拉取所有玩家记录（含已隐藏的），用于统计
        const allPRes = await db.collection('Players')
          .where({ user_id: OPENID })
          .orderBy('joined_at', 'desc')
          .limit(100)
          .get()

        const allData = allPRes.data || []

        // 统计数据：不过滤 is_hidden（修复 Bug）
        let wins = 0, losses = 0, totalPoints = 0
        let maxScore = 0, minScore = 0

        allData.forEach(p => {
          const score = Number(p.current_score || 0)
          totalPoints += score
          if (score > 0) wins++
          if (score < 0) losses++
          if (score > maxScore) maxScore = score
          if (score < minScore) minScore = score
        })

        const totalGames = allData.length
        const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0
        const avgScore = totalGames > 0 ? Math.round(totalPoints / totalGames) : 0

        // 活跃房间：只显示未隐藏的，最多 10 条
        const visibleRecords = allData
          .filter(p => p.is_hidden !== true)
          .slice(0, 10)

        const activeRooms = []
        if (visibleRecords.length > 0) {
          const roomIds = [...new Set(visibleRecords.map(p => p.room_id))]
          const rRes = await db.collection('Rooms').where({ _id: _.in(roomIds) }).get()
          rRes.data.forEach(room => {
            const date = new Date(new Date(room.created_at || Date.now()).getTime() + 8 * 3600 * 1000)
            activeRooms.push({
              room_id: room._id,
              room_code: room.room_code,
              date_str: `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`,
              created_at: room.created_at
            })
          })
          activeRooms.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        }

        return {
          stats: {
            wins, losses, totalPoints, winRate,
            maxScore, minScore, avgScore, totalGames,
            rank: wins > 2 ? 100 : (wins > 0 ? 500 : '较远')
          },
          activeRooms: activeRooms.slice(0, 5)
        }
      } catch (e) {
        return { error: '查询超时', detail: e.message }
      }
    }

    // ─── 历史所有房间（不含已隐藏）──────────────────────────────────────
    case 'getAllRooms': {
      try {
        const pRes = await db.collection('Players')
          .where({ user_id: OPENID, is_hidden: _.neq(true) })
          .orderBy('joined_at', 'desc')
          .limit(50)
          .get()

        const records = pRes.data || []
        if (records.length === 0) return { rooms: [] }

        const roomIds = [...new Set(records.map(p => p.room_id))]
        const rRes = await db.collection('Rooms').where({ _id: _.in(roomIds) }).get()

        // 同时查询每个房间我的得分
        const scoreMap = {}
        records.forEach(p => { scoreMap[p.room_id] = Number(p.current_score || 0) })

        const rooms = rRes.data.map(room => {
          const date = new Date(new Date(room.created_at || Date.now()).getTime() + 8 * 3600 * 1000)
          return {
            room_id: room._id,
            room_code: room.room_code,
            my_score: scoreMap[room._id] || 0,
            date_str: `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`,
            created_at: room.created_at
          }
        })
        rooms.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        return { rooms }
      } catch (e) {
        return { error: e.message, rooms: [] }
      }
    }

    // ─── 更新个人资料（头像/昵称），批量同步所有历史房间 ───────────────
    case 'updateProfile': {
      try {
        const { nickname, avatar } = data
        const updateFields = {}
        if (nickname !== undefined) updateFields.nickname = nickname
        if (avatar !== undefined) updateFields.avatar = avatar
        if (Object.keys(updateFields).length === 0) return { success: false, msg: '无更新内容' }

        // 查出该用户所有 Players 记录
        const pRes = await db.collection('Players')
          .where({ user_id: OPENID, is_virtual: _.neq(true) })
          .limit(100)
          .get()

        const updates = pRes.data.map(p =>
          db.collection('Players').doc(p._id).update({ data: updateFields })
        )
        await Promise.all(updates)
        return { success: true, updated: pRes.data.length }
      } catch (e) {
        return { success: false, error: e.message }
      }
    }

    // ─── 隐藏房间 ──────────────────────────────────────────────────────────
    case 'hideRoom': {
      const pCheck = await db.collection('Players')
        .where({ room_id: data.room_id, user_id: OPENID })
        .get()
      if (pCheck.data.length > 0) {
        await db.collection('Players').doc(pCheck.data[0]._id)
          .update({ data: { is_hidden: true } })
        return { success: true }
      }
      return { success: false }
    }

    // ─── 生成/获取二维码 ──────────────────────────────────────────────────
    case 'getRoomQR': {
      const roomInfo = await db.collection('Rooms').doc(data.room_id).get()
      if (roomInfo.data.qr_code_url) return { qrCodeUrl: roomInfo.data.qr_code_url }
      const qrRes = await cloud.openapi.wxacode.getUnlimited({
        scene: data.room_id,
        page: 'pages/index/index',
        checkPath: false,
        envVersion: 'develop'
      })
      const uploadRes = await cloud.uploadFile({
        cloudPath: `room_qr/${data.room_id}_${Date.now()}.png`,
        fileContent: qrRes.buffer
      })
      await db.collection('Rooms').doc(data.room_id)
        .update({ data: { qr_code_url: uploadRes.fileID } })
      return { qrCodeUrl: uploadRes.fileID }
    }

    // ─── 创建房间 ──────────────────────────────────────────────────────────
    case 'create': {
      const roomCode = Math.random().toString().slice(2, 8)
      const roomRes = await db.collection('Rooms').add({
        data: {
          host_id: OPENID,
          room_code: roomCode,
          status: 'active',
          table_fee: 0,
          created_at: db.serverDate(),
          rules: data.rules || {}
        }
      })
      
      // 修改：保留最近 3 个活跃房间，其余隐藏
      const allActive = await db.collection('Players')
        .where({ user_id: OPENID, is_hidden: _.neq(true) })
        .orderBy('joined_at', 'desc')
        .get()
      
      if (allActive.data.length >= 3) {
        // 如果已经有 3 个或更多，把最老的那批隐藏掉（保留最新的 2 个，加上现在要加的这个刚好 3 个）
        const idsToHide = allActive.data.slice(2).map(p => p._id)
        await db.collection('Players').where({ _id: _.in(idsToHide) }).update({ data: { is_hidden: true } })
      }

      await db.collection('Players').add({
        data: {
          room_id: roomRes._id,
          user_id: OPENID,
          nickname: data.nickname,
          avatar: data.avatar || '',
          current_score: 0,
          is_host: true,
          is_virtual: false,
          is_hidden: false,
          joined_at: db.serverDate()
        }
      })
      return { roomId: roomRes._id, roomCode }
    }

    // ─── 提交一局（含零和校验）────────────────────────────────────────────
    case 'submitRound': {
      const tFeeDelta = Number(data.table_fee || 0)
      const rawScores = data.scores || {}

      // 服务端零和校验：所有玩家分数之和 + 台面费变化 必须 = 0
      let scoreSum = 0
      const updateData = {}
      Object.keys(rawScores).forEach(pid => {
        const val = Number(rawScores[pid] || 0)
        updateData[pid] = val
        scoreSum += val
      })
      const total = scoreSum + tFeeDelta
      if (total !== 0) {
        return {
          success: false,
          error: `零和校验失败：所有分数之和为 ${scoreSum}，台面费 ${tFeeDelta}，合计 ${total} ≠ 0`
        }
      }

      // 更新台面费
      if (tFeeDelta !== 0) {
        await db.collection('Rooms').doc(data.room_id)
          .update({ data: { table_fee: _.inc(tFeeDelta) } })
      }

      // 更新玩家分数 + 写入流水
      const promises = Object.keys(updateData).map(pid =>
        db.collection('Players').doc(pid)
          .update({ data: { current_score: _.inc(updateData[pid]) } })
      )
      promises.push(
        db.collection('Rounds').add({
          data: {
            room_id: data.room_id,
            scores: updateData,
            table_fee_delta: tFeeDelta,
            created_at: db.serverDate(),
            operator_id: OPENID
          }
        })
      )
      await Promise.all(promises)
      return { success: true }
    }

    // ─── 加入房间 ──────────────────────────────────────────────────────────
    case 'join': {
      const { room_id } = data
      const exist = await db.collection('Players')
        .where({ room_id: room_id, user_id: OPENID })
        .get()
      
      // 修改：保留最近 3 个活跃房间，其余隐藏
      const allActive = await db.collection('Players')
        .where({ user_id: OPENID, is_hidden: _.neq(true), room_id: _.neq(room_id) })
        .orderBy('joined_at', 'desc')
        .get()
      
      if (allActive.data.length >= 3) {
        const idsToHide = allActive.data.slice(2).map(p => p._id)
        await db.collection('Players').where({ _id: _.in(idsToHide) }).update({ data: { is_hidden: true } })
      }

      if (exist.data.length > 0) {
        // 如果之前加入过，重新激活并更新加入时间以排到最前
        await db.collection('Players').doc(exist.data[0]._id).update({ 
          data: { is_hidden: false, is_kicked: false, joined_at: db.serverDate() } 
        })
        return { success: true, existed: true }
      }

      await db.collection('Players').add({
        data: {
          room_id: room_id,
          user_id: OPENID,
          nickname: data.nickname,
          avatar: data.avatar || '',
          current_score: 0,
          is_virtual: false,
          is_hidden: false,
          joined_at: db.serverDate()
        }
      })
      return { success: true }
    }

    // ─── 添加虚拟玩家 ──────────────────────────────────────────────────────
    case 'addVirtual': {
      await db.collection('Players').add({
        data: {
          room_id: data.room_id,
          user_id: null,
          nickname: data.nickname,
          avatar: '',
          current_score: 0,
          is_virtual: true,
          joined_at: db.serverDate()
        }
      })
      return { success: true }
    }

    // ─── 踢出玩家 ──────────────────────────────────────────────────────────
    case 'kick': {
      const { room_id, player_id } = data
      const room = await db.collection('Rooms').doc(room_id).get()
      if (room.data.host_id !== OPENID) {
        return { success: false, msg: '只有管理员有权踢人' }
      }
      await db.collection('Players').doc(player_id).update({
        data: { is_kicked: true }
      })
      return { success: true }
    }

    // ─── 恢复玩家 ──────────────────────────────────────────────────────────
    case 'restore': {
      const { room_id, player_id } = data
      const room = await db.collection('Rooms').doc(room_id).get()
      if (room.data.host_id !== OPENID) {
        return { success: false, msg: '只有管理员有权操作' }
      }
      await db.collection('Players').doc(player_id).update({
        data: { is_kicked: false }
      })
      return { success: true }
    }

    // ─── 获取 openid ───────────────────────────────────────────────────────
    case 'getOpenid':
      return { openid: OPENID }

    default:
      return { success: false, msg: 'unknown action' }
  }
}
