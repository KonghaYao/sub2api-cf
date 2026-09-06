export default {
  audit: {
    title: 'Audit Events',
    description: 'Read-only management, authentication, and payment events. Sensitive identifiers are masked and detail metadata is allow-listed.',
    empty: 'No audit events yet',
    loadFailed: 'Failed to load audit events',
    filters: {
      all: 'All',
      category: 'Category',
      action: 'Action',
      outcome: 'Outcome',
      actorUserId: 'Actor user ID',
      resourceType: 'Resource type',
      resourceId: 'Resource ID'
    },
    categories: {
      settings: 'Settings',
      rbac: 'RBAC',
      account: 'Accounts',
      auth: 'Authentication',
      payment: 'Payment'
    },
    outcomes: {
      succeeded: 'Succeeded',
      failed: 'Failed',
      blocked: 'Blocked',
      recorded: 'Recorded'
    },
    columns: {
      time: 'Time',
      category: 'Category',
      actor: 'Actor',
      action: 'Action',
      outcome: 'Outcome',
      resource: 'Resource',
      detail: 'Detail'
    },
    pagination: {
      page: 'Page {page}',
      previous: 'Previous audit page',
      next: 'Next audit page'
    },
    detail: {
      title: 'Audit Event Detail',
      actor: 'Actor',
      origin: 'Origin',
      resource: 'Resource',
      version: 'version {version}',
      metadata: 'Allow-listed metadata'
    }
  }
}
