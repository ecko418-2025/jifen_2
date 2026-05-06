const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_TYPE_CA })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  return {
    openid: wxContext.OPENID,
    unionid: wxContext.UNIONID,
  }
}
