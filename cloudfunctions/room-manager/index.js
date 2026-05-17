const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function generateUniqueRoomCode(maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    const roomCode = Math.floor(100000 + Math.random() * 900000).toString()
    const existRes = await db.collection('Rooms')
      .where({ room_code: roomCode })
      .limit(1)
      .get()
    if ((existRes.data || []).length === 0) return roomCode
  }
  throw new Error('房间号生成失败，请重试')
}

function calculateTransfers(players) {
  const debtors = []
  const creditors = []

  players.forEach(p => {
    const score = Number(p.current_score || 0)
    if (score < 0) {
      debtors.push({ player_id: p.player_id || null, name: p.nickname, amount: Math.abs(score) })
    } else if (score > 0) {
      creditors.push({ player_id: p.player_id || null, name: p.nickname, amount: score })
    }
  })

  const transfers = []
  let i = 0
  let j = 0
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount)
    transfers.push({
      from_player_id: debtors[i].player_id,
      from: debtors[i].name,
      to_player_id: creditors[j].player_id,
      to: creditors[j].name,
      amount
    })

    debtors[i].amount -= amount
    creditors[j].amount -= amount
    if (debtors[i].amount === 0) i++
    if (creditors[j].amount === 0) j++
  }

  return transfers
}

function buildFinalSnapshot(players, tableFee) {
  const playerSnapshots = players.map(p => ({
    player_id: p._id,
    user_id: p.user_id || null,
    nickname: p.nickname || '未知用户',
    avatar: p.avatar || '',
    current_score: Number(p.current_score || 0),
    is_host: !!p.is_host,
    is_virtual: !!p.is_virtual,
    is_kicked: !!p.is_kicked
  }))
  const playersForSettle = playerSnapshots.map(p => ({
    player_id: p.player_id,
    nickname: p.nickname,
    current_score: p.current_score
  }))

  if (tableFee > 0) {
    playersForSettle.push({
      player_id: null,
      nickname: '台面 (结余)',
      current_score: tableFee
    })
  }

  return {
    version: 1,
    table_fee: tableFee,
    total_player_score: playerSnapshots.reduce((sum, p) => sum + p.current_score, 0),
    players: playerSnapshots,
    transfers: calculateTransfers(playersForSettle)
  }
}

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
          .limit(1000)
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
            if (room.status === 'closed') return
            const date = new Date(new Date(room.created_at || Date.now()).getTime() + 8 * 3600 * 1000)
            activeRooms.push({
              room_id: room._id,
              room_code: room.room_code,
              status: room.status || 'active',
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
          .limit(1000)
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
            status: room.status || 'active',
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
          .limit(1000)
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
      const qrEnvVersion = 'release'
      if (roomInfo.data.qr_code_url && roomInfo.data.qr_code_env_version === qrEnvVersion) {
        return { qrCodeUrl: roomInfo.data.qr_code_url }
      }
      const qrRes = await cloud.openapi.wxacode.getUnlimited({
        scene: data.room_id,
        page: 'pages/index/index',
        checkPath: false,
        envVersion: qrEnvVersion
      })
      const uploadRes = await cloud.uploadFile({
        cloudPath: `room_qr/${qrEnvVersion}_${data.room_id}_${Date.now()}.png`,
        fileContent: qrRes.buffer
      })
      await db.collection('Rooms').doc(data.room_id)
        .update({
          data: {
            qr_code_url: uploadRes.fileID,
            qr_code_env_version: qrEnvVersion
          }
        })
      return { qrCodeUrl: uploadRes.fileID }
    }

    // ─── 创建房间 ──────────────────────────────────────────────────────────
    case 'create': {
      const roomCode = await generateUniqueRoomCode()
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
      
      // 已移除：自动隐藏旧房间的逻辑，现在保留所有历史记录

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
      const payload = data || {}
      const roomId = payload.room_id
      const tFeeDelta = Number(payload.table_fee || 0)
      const rawScores = payload.scores || {}

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

      if (!roomId) {
        return { success: false, error: '缺少房间信息' }
      }

      const scorePlayerIds = Object.keys(updateData)
      if (scorePlayerIds.length === 0) {
        return { success: false, error: '缺少玩家分数变动' }
      }

      let room
      try {
        const roomRes = await db.collection('Rooms').doc(roomId).get()
        room = roomRes.data
      } catch (e) {
        return { success: false, error: '房间不存在或已失效' }
      }
      if (room.status === 'closed') {
        return { success: false, error: '房间已结算，不能继续记账' }
      }

      const playersRes = await db.collection('Players')
        .where({ room_id: roomId })
        .limit(1000)
        .get()
      const roomPlayers = playersRes.data || []
      const playerMap = {}
      roomPlayers.forEach(p => { playerMap[p._id] = p })

      const operatorPlayer = roomPlayers.find(p => p.user_id === OPENID && p.is_virtual !== true)
      if (!operatorPlayer || operatorPlayer.is_kicked === true) {
        return { success: false, error: '你不是该房间的有效玩家，无法记账' }
      }

      const invalidPlayerIds = scorePlayerIds.filter(pid => !playerMap[pid])
      if (invalidPlayerIds.length > 0) {
        return { success: false, error: '提交中包含不属于该房间的玩家' }
      }

      const kickedPlayers = scorePlayerIds
        .map(pid => playerMap[pid])
        .filter(p => p.is_kicked === true)
      if (kickedPlayers.length > 0) {
        return { success: false, error: '已退出房间的玩家不能参与新的记账' }
      }

      if (room.host_id !== OPENID && updateData[operatorPlayer._id] === undefined) {
        return { success: false, error: '非房主只能提交包含自己分数变动的账目' }
      }

      // 更新台面费
      if (tFeeDelta !== 0) {
        await db.collection('Rooms').doc(roomId)
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
            room_id: roomId,
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

    // ─── 关闭房间并保存最终结算快照 ───────────────────────────────────────
    case 'closeRoom': {
      const payload = data || {}
      const roomId = payload.room_id
      if (!roomId) {
        return { success: false, error: '缺少房间信息' }
      }

      let room
      try {
        const roomRes = await db.collection('Rooms').doc(roomId).get()
        room = roomRes.data
      } catch (e) {
        return { success: false, error: '房间不存在或已失效' }
      }

      if (room.host_id !== OPENID) {
        return { success: false, error: '只有房主可以结束房间' }
      }

      if (room.status === 'closed') {
        return {
          success: true,
          alreadyClosed: true,
          finalSnapshot: room.final_snapshot || null
        }
      }

      const playersRes = await db.collection('Players')
        .where({ room_id: roomId })
        .limit(1000)
        .get()
      const players = playersRes.data || []
      const finalSnapshot = buildFinalSnapshot(players, Number(room.table_fee || 0))

      await db.collection('Rooms').doc(roomId).update({
        data: {
          status: 'closed',
          closed_at: db.serverDate(),
          closed_by: OPENID,
          final_snapshot: finalSnapshot
        }
      })

      return {
        success: true,
        finalSnapshot
      }
    }

    // ─── 加入房间 ──────────────────────────────────────────────────────────
    case 'join': {
      const { room_id } = data
      const exist = await db.collection('Players')
        .where({ room_id: room_id, user_id: OPENID })
        .get()
      const roomRes = await db.collection('Rooms').doc(room_id).get()
      const room = roomRes.data
      
      // 已移除：自动隐藏旧房间的逻辑，现在保留所有历史记录

      if (exist.data.length > 0) {
        if (room.status === 'closed') {
          return { success: true, existed: true, closed: true }
        }
        // 如果之前加入过，重新激活并更新加入时间以排到最前
        await db.collection('Players').doc(exist.data[0]._id).update({ 
          data: { is_hidden: false, is_kicked: false, joined_at: db.serverDate() } 
        })
        return { success: true, existed: true }
      }

      if (room.status === 'closed') {
        return { success: false, error: '房间已结算，不能加入' }
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
      const room = await db.collection('Rooms').doc(data.room_id).get()
      if (room.data.status === 'closed') {
        return { success: false, error: '房间已结算，不能添加玩家' }
      }
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
      if (room.data.status === 'closed') {
        return { success: false, msg: '房间已结算，不能踢出玩家' }
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
      if (room.data.status === 'closed') {
        return { success: false, msg: '房间已结算，不能恢复玩家' }
      }
      await db.collection('Players').doc(player_id).update({
        data: { is_kicked: false }
      })
      return { success: true }
    }

    // ─── 获取房间状态（房间信息/玩家/流水）────────────────────────────────
    case 'getRoomState': {
      try {
        const payload = data || {}
        const { room_id } = payload
        if (!room_id) {
          return { success: false, error: '缺少房间信息' }
        }

        const roomRes = await db.collection('Rooms').doc(room_id).get()
        const room = roomRes.data
        const result = {
          success: true,
          room: {
            room_id: room._id,
            room_code: room.room_code,
            table_fee: Number(room.table_fee || 0),
            qr_code_url: room.qr_code_env_version === 'release' ? (room.qr_code_url || '') : '',
            qr_code_env_version: room.qr_code_env_version || '',
            host_id: room.host_id,
            status: room.status || 'active'
          }
        }

        if (payload.include_players === true) {
          const playersRes = await db.collection('Players')
            .where({ room_id })
            .limit(1000)
            .get()
          result.players = (playersRes.data || []).map(p => ({
            _id: p._id,
            user_id: p.user_id || null,
            nickname: p.nickname || '未知用户',
            avatar: p.avatar || '',
            current_score: Number(p.current_score || 0),
            is_kicked: !!p.is_kicked,
            is_virtual: !!p.is_virtual
          }))
        }

        if (payload.include_rounds === true) {
          const roundsRes = await db.collection('Rounds')
            .where({ room_id })
            .orderBy('created_at', 'desc')
            .limit(1000)
            .get()
          result.rounds = roundsRes.data || []
        }

        return result
      } catch (e) {
        return { success: false, error: e.message }
      }
    }

    // ─── 获取房间内所有流水（对局记录） ────────────────────────────────────
    case 'getRounds': {
      try {
        const { room_id } = data
        const rRes = await db.collection('Rounds')
          .where({ room_id: room_id })
          .orderBy('created_at', 'desc')
          .limit(1000)
          .get()
        return { success: true, rounds: rRes.data || [] }
      } catch (e) {
        return { success: false, error: e.message }
      }
    }

    // ─── 获取 openid ───────────────────────────────────────────────────────
    case 'getOpenid':
      return { openid: OPENID }

    default:
      return { success: false, msg: 'unknown action' }
  }
}
