// Audit Log Model for tracking admin actions

export enum AuditAction {
  USER_UPDATE = 'USER_UPDATE',
  USER_SUSPEND = 'USER_SUSPEND',
  USER_UNSUSPEND = 'USER_UNSUSPEND',
  USER_ROLE_CHANGE = 'USER_ROLE_CHANGE',
  WALLET_CREDIT = 'WALLET_CREDIT',
  WALLET_DEBIT = 'WALLET_DEBIT',
  PURCHASE_REFUND = 'PURCHASE_REFUND',
  CONFIG_UPDATE = 'CONFIG_UPDATE',
  PROVIDER_CLAIM = 'PROVIDER_CLAIM',
}

export interface AuditLog {
  id: string;
  adminId: string;
  adminEmail: string;
  action: AuditAction;
  targetType: 'user' | 'wallet' | 'purchase' | 'config' | 'provider';
  targetId: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

export interface CreateAuditLogDto {
  adminId: string;
  adminEmail: string;
  action: AuditAction;
  targetType: 'user' | 'wallet' | 'purchase' | 'config' | 'provider';
  targetId: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}
