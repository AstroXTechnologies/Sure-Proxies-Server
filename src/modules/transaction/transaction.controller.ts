import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CreateTransactionDto, UpdateTransactionDto } from './transaction.dto';

import { ApAuthGuard } from 'src/modules/auth/auth-guard.decorator';
import { UserRole } from 'src/modules/user/user.model';
import { TransactionsService } from './transaction.service';

@ApAuthGuard(UserRole.USER)
@ApiBearerAuth('access-token')
@ApiTags('Transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}

  @Post(':userId')
  @ApiOperation({ summary: 'Create a new transaction for a user' })
  create(@Param('userId') userId: string, @Body() dto: CreateTransactionDto) {
    return this.service.create(userId, dto);
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Get all transactions for a user' })
  findAll(@Param('userId') userId: string) {
    return this.service.findAll(userId);
  }

  @Get('status/:transactionId')
  @ApiOperation({ summary: 'Get transaction status by transaction ID' })
  async getTransactionStatus(@Param('transactionId') transactionId: string) {
    return await this.service.getTransactionById(transactionId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a transaction status' })
  update(@Param('id') id: string, @Body() dto: UpdateTransactionDto) {
    return this.service.update(id, dto);
  }

  @Get('transaction/:transactionId')
  @ApiOperation({ summary: 'Get history for a specific transaction' })
  async getTransactionHistory(@Param('transactionId') transactionId: string) {
    return this.service.getTransactionHistoryByTransactionId(transactionId);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get all transaction histories for a user' })
  async getTransactionHistoryByUserId(@Param('userId') userId: string) {
    return this.service.getTransactionHistoryByUserId(userId);
  }

  // ========== ADMIN ENDPOINTS ==========

  @Get('admin/all')
  @ApiOperation({
    summary: 'Get all transactions (Admin only)',
    description: 'Retrieve all transactions with pagination and filters.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiQuery({ name: 'userId', required: false, type: String })
  @ApAuthGuard(UserRole.ADMIN)
  findAllAdmin(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('userId') userId?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 50));

    return this.service.findAllAdmin(p, l, { status, type, userId });
  }

  @Get('admin/stats')
  @ApiOperation({
    summary: 'Get transaction statistics (Admin only)',
    description: 'Get count of transactions by status and type.',
  })
  @ApAuthGuard(UserRole.ADMIN)
  getStats() {
    return this.service.getTransactionStats();
  }
}
