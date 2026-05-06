function calculateTransfers(players) {
  let debtors = [] // 输家
  let creditors = [] // 赢家

  players.forEach(p => {
    if (p.current_score < 0) {
      debtors.push({ name: p.nickname, amount: Math.abs(p.current_score) })
    } else if (p.current_score > 0) {
      creditors.push({ name: p.nickname, amount: p.current_score })
    }
  })

  const transfers = []
  let i = 0, j = 0
  
  while (i < debtors.length && j < creditors.length) {
    const payAmount = Math.min(debtors[i].amount, creditors[j].amount)
    
    transfers.push({
      from: debtors[i].name,
      to: creditors[j].name,
      amount: payAmount
    })

    debtors[i].amount -= payAmount
    creditors[j].amount -= payAmount

    if (debtors[i].amount === 0) i++
    if (creditors[j].amount === 0) j++
  }

  return transfers
}

module.exports = {
  calculateTransfers: calculateTransfers
}
