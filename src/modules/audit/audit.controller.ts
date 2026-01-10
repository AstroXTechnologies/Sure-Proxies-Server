import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApAuthGuard } from '../auth/auth-guard.decorator';
import { UserRole } from '../user/user.model';
import { AuditService } from './audit.service';

@ApiTags('Audit Logs')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Get audit logs (Admin only)',
    description: 'Retrieve paginated audit logs with optional filters.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'action', required: false, type: String })
  @ApiQuery({ name: 'adminId', required: false, type: String })
  @ApiQuery({ name: 'targetType', required: false, type: String })
  @ApAuthGuard(UserRole.ADMIN)
  findAll(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('action') action?: string,
    @Query('adminId') adminId?: string,
    @Query('targetType') targetType?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 50));

    return this.auditService.findAll(p, l, {
      action,
      adminId,
      targetType,
    });
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get audit action statistics (Admin only)',
    description: 'Get count of actions by type.',
  })
  @ApAuthGuard(UserRole.ADMIN)
  getStats() {
    return this.auditService.getActionStats();
  }

  @Get('by-target')
  @ApiOperation({
    summary: 'Get audit logs for a specific target (Admin only)',
    description: 'Retrieve all audit logs for a specific target entity.',
  })
  @ApiQuery({ name: 'targetType', required: true, type: String })
  @ApiQuery({ name: 'targetId', required: true, type: String })
  @ApAuthGuard(UserRole.ADMIN)
  findByTarget(
    @Query('targetType') targetType: string,
    @Query('targetId') targetId: string,
  ) {
    return this.auditService.findByTarget(targetType, targetId);
  }
}
