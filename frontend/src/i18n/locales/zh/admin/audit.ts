export default {
  audit: {
    title: '审计事件',
    description: '只读展示管理、认证与支付事件；敏感标识已掩码，详情仅返回白名单字段。',
    empty: '暂无审计事件',
    loadFailed: '加载审计事件失败',
    filters: {
      all: '全部',
      category: '分类',
      action: '动作',
      outcome: '结果',
      actorUserId: '操作者用户 ID',
      resourceType: '资源类型',
      resourceId: '资源 ID'
    },
    categories: {
      settings: '系统设置',
      rbac: '权限管理',
      account: '账号',
      auth: '认证安全',
      payment: '支付'
    },
    outcomes: {
      succeeded: '成功',
      failed: '失败',
      blocked: '已阻止',
      recorded: '已记录'
    },
    columns: {
      time: '时间',
      category: '分类',
      actor: '操作者',
      action: '动作',
      outcome: '结果',
      resource: '资源',
      detail: '详情'
    },
    pagination: {
      page: '第 {page} 页',
      previous: '上一页审计事件',
      next: '下一页审计事件'
    },
    detail: {
      title: '审计事件详情',
      actor: '操作者',
      origin: '来源',
      resource: '资源',
      version: '版本 {version}',
      metadata: '白名单元数据'
    }
  }
}
