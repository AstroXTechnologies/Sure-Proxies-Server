import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction } from 'src/modules/audit/audit.model';
import { AuditService } from 'src/modules/audit/audit.service';
import { ApAuthGuard } from 'src/modules/auth/auth-guard.decorator';
import { UserRole } from 'src/modules/user/user.model';

import { PriceInputDto, ProxyOrderPurchaseInputDto } from './order.dto';
import { ProxyOrderModel, PurchaseOrderModel } from './order.model';
import { ProxyOrderService } from './order.service';

interface AuthenticatedUser {
  uid: string;
  idToken: string;
  email: string;
}

interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

// @ApAuthGuard()
@ApiTags('Proxy Order')
@Controller('proxy_order')
export class ProxyOrderController {
  constructor(
    private readonly proxyOrderService: ProxyOrderService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Get a list of order services (emphasis on the services) available for purchase',
  })
  @ApiResponse({
    status: 200,
    description:
      'This endpoint is the entry point to the whole ordering process. It returns the list of orderable services, and optionally their plans when supported. The service and plan identifiers are required to be included within payloads of all the remaining endpoints: setup, price & execute.',
    isArray: true,
    type: [ProxyOrderModel],
  })
  async getAvailableProxies(): Promise<ProxyOrderModel[]> {
    return this.proxyOrderService.getAvailableProxiesServices();
  }

  @Get(':serviceId/options')
  @ApiOperation({
    summary: 'Available options to the service',
  })
  @ApiResponse({
    status: 200,
    description:
      "This allows you to fetch all the order properties available for the selected service. Some of the services might require a planId - refer to the plans available under the specific service in the /proxy_order endpoint. Each service might be described by different properties, so you shouldn't assume they all work the same way.",
  })
  @ApiParam({
    name: 'planId',
    required: false,
  })
  async getServiceOptions(
    @Param('serviceId') serviceId: string,
    @Query('planId') planId?: string,
  ) {
    return this.proxyOrderService.getServiceOptions(serviceId, planId);
  }

  @Post(':serviceId/price')
  @ApiOperation({
    summary: 'Api to get price of a service',
  })
  @ApiBody({
    type: PriceInputDto,
  })
  @ApiResponse({
    description:
      'This endpoint allows to get a price for the selected configuration for a particular service. The response contains information about the total, subtotal, markups, discounts & unit prices.',
  })
  async getPrice(
    @Param('serviceId') serviceId: string,
    @Body() model: PriceInputDto,
  ) {
    return this.proxyOrderService.getPrice(serviceId, model);
  }

  @Post(':serviceId/purchase')
  @ApiBody({
    description: 'Enter the options',
    // Use the proxy purchase DTO which supports packageId / traffic-only variants
    type: ProxyOrderPurchaseInputDto,
  })
  purchase(
    @Param('serviceId') serviceId: string,
    @Body('model') model: ProxyOrderPurchaseInputDto,
  ) {
    // Cast via unknown to avoid unsafe-any lint warnings while preserving the explicit DTO type
    return this.proxyOrderService.purchaseProxy(
      serviceId,
      model as unknown as ProxyOrderPurchaseInputDto,
    );
  }

  @Post('finalize/:transactionId')
  @ApiOperation({ summary: 'Finalize a pending purchase by transactionId' })
  async finalizePurchase(@Param('transactionId') transactionId: string) {
    return this.proxyOrderService.finalizePurchase(transactionId);
  }

  @Get('my-purchases')
  @ApAuthGuard(UserRole.USER)
  @ApiOperation({ summary: 'Get all purchases of the logged-in user' })
  async getMyPurchases(
    @Req() req: AuthenticatedRequest,
  ): Promise<PurchaseOrderModel[]> {
    const userId = req.user.uid;
    return this.proxyOrderService.getUserPurchases(userId);
  }

  @Get('my-expiring-soon')
  @ApAuthGuard(UserRole.USER)
  @ApiOperation({
    summary: 'Get purchases expiring soon for the logged-in user',
  })
  async getMyExpiringSoon(
    @Req() req: AuthenticatedRequest,
  ): Promise<PurchaseOrderModel[]> {
    const userId = req.user.uid;
    return this.proxyOrderService.getExpiringSoonPurchases(userId);
  }

  @Get('my-inactive')
  @ApAuthGuard(UserRole.USER)
  @ApiOperation({
    summary: 'Get inactive (expired) purchases for the logged-in user',
  })
  async getMyInactive(
    @Req() req: AuthenticatedRequest,
  ): Promise<PurchaseOrderModel[]> {
    const userId = req.user.uid;
    return this.proxyOrderService.getInactivePurchases(userId);
  }

  @Get('my-total-spent')
  @ApAuthGuard(UserRole.USER)
  @ApiOperation({ summary: 'Get total spent by the logged-in user' })
  async getMyTotalSpent(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ totalSpent: number }> {
    const userId = req.user.uid;
    const totalSpent = await this.proxyOrderService.getTotalSpent(userId);
    return { totalSpent };
  }

  // --------------------- ADMIN ROUTES --------------------- //

  @Get('admin/all-purchases')
  @ApiOperation({ summary: 'Get all purchases (Admin only)' })
  async getAllPurchases(): Promise<PurchaseOrderModel[]> {
    return this.proxyOrderService.getAllPurchases();
  }

  @Post('admin/update-markup')
  @ApAuthGuard(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update pricing markup (Admin only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        globalMarkup: { type: 'number', example: 20 },
        perServiceMarkup: {
          type: 'object',
          additionalProperties: { type: 'number' },
          example: { 'service-1': 25, 'service-2': 15 },
        },
      },
      required: ['globalMarkup'],
    },
  })
  async updateMarkup(
    @Req() req: AuthenticatedRequest,
    @Body('globalMarkup') globalMarkup: number,
    @Body('perServiceMarkup') perServiceMarkup: Record<string, number>,
  ) {
    const result = await this.proxyOrderService.updateMarkup(
      globalMarkup,
      perServiceMarkup,
    );

    // Audit log
    await this.auditService.create({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: AuditAction.CONFIG_UPDATE,
      targetType: 'config',
      targetId: 'pricing-markup',
      details: { globalMarkup, perServiceMarkup },
    });

    return result;
  }

  @Post('admin/create-config')
  @ApAuthGuard(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create initial pricing config (Admin only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        globalMarkup: { type: 'number', example: 0 },
        perServiceMarkup: {
          type: 'object',
          additionalProperties: { type: 'number' },
          example: { 'service-1': 20, 'service-2': 10 },
        },
      },
    },
  })
  async createConfig(
    @Req() req: AuthenticatedRequest,
    @Body('globalMarkup') globalMarkup: number,
    @Body('perServiceMarkup') perServiceMarkup: Record<string, number>,
  ) {
    const result = await this.proxyOrderService.createConfig(
      globalMarkup,
      perServiceMarkup,
    );

    // Audit log
    await this.auditService.create({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: AuditAction.CONFIG_UPDATE,
      targetType: 'config',
      targetId: 'pricing-config',
      details: { globalMarkup, perServiceMarkup },
    });

    return result;
  }

  @Get('admin/config')
  @ApAuthGuard(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get pricing config (Admin only)' })
  async getConfig() {
    return this.proxyOrderService.getPricingConfig();
  }

  @Get('admin/provider-mappings')
  @ApAuthGuard(UserRole.ADMIN)
  @ApiOperation({ summary: 'List provider -> user mappings (Admin only)' })
  async listProviderMappings(@Query('limit') limit?: string): Promise<any> {
    const l = limit ? parseInt(limit, 10) : undefined;
    return await this.proxyOrderService.getProviderMappings(l);
  }

  @Get('admin/provider-mappings/:providerId')
  @ApAuthGuard(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Get a provider mapping by providerId (Admin only)',
  })
  async getProviderMapping(@Param('providerId') providerId: string) {
    return this.proxyOrderService.getProviderMapping(providerId);
  }

  @Post('admin/provider-mappings/:providerId/claim')
  @ApAuthGuard(UserRole.ADMIN)
  @ApiOperation({ summary: 'Claim a provider mapping (Admin only)' })
  async claimProviderMapping(
    @Param('providerId') providerId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const adminId = req.user?.uid || 'unknown-admin';
    const result = await this.proxyOrderService.claimProviderMapping(
      providerId,
      adminId,
    );

    // Audit log
    await this.auditService.create({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: AuditAction.PROVIDER_CLAIM,
      targetType: 'provider',
      targetId: providerId,
      details: { claimedBy: adminId },
    });

    return result;
  }
}
