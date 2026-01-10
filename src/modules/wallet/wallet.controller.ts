import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApAuthGuard } from '../auth/auth-guard.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { UserRole } from '../user/user.model';
import type { DepositRequest, WithdrawalRequest } from './wallet.model';
import { WalletService } from './wallet.service';

@ApiTags('Wallet')
@Controller('wallet')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  getWallet(@Req() req: { user: { uid: string } }) {
    const userId = req.user.uid;
    return this.walletService.getOrCreateWallet(userId);
  }

  @Get('transactions')
  getTransactions(@Req() req: { user: { uid: string } }) {
    const userId = req.user.uid;
    return this.walletService.getTransactions(userId);
  }

  @Post('deposit/initiate')
  initiateDeposit(
    @Req() req: { user: { uid: string } },
    @Body() depositRequest: DepositRequest,
  ) {
    const userId = req.user.uid;
    return this.walletService.initiateDeposit(userId, depositRequest.amount);
  }

  @Post('withdraw')
  requestWithdrawal(
    @Req() req: { user: { uid: string } },
    @Body() withdrawalRequest: WithdrawalRequest,
  ) {
    const userId = req.user.uid;
    return this.walletService.requestWithdrawal(userId, withdrawalRequest);
  }

  // ========== ADMIN ENDPOINTS ==========

  @Get('admin/:userId')
  @ApiOperation({
    summary: 'Get wallet by user ID (Admin only)',
    description: 'Retrieve wallet details for a specific user. Admin only.',
  })
  @ApAuthGuard(UserRole.ADMIN)
  getWalletByAdmin(@Param('userId') userId: string) {
    return this.walletService.getOrCreateWallet(userId);
  }

  @Post('admin/:userId/adjust')
  @ApiOperation({
    summary: 'Adjust wallet balance (Admin only)',
    description:
      'Credit or debit a user wallet. Positive amount = credit, negative = debit. Creates audit log.',
  })
  @ApAuthGuard(UserRole.ADMIN)
  adjustBalance(
    @Req() req: { user: { uid: string; email?: string } },
    @Param('userId') userId: string,
    @Body() body: { amount: number; reason: string },
  ) {
    const adminId = req.user.uid;
    const adminEmail = req.user.email || 'unknown';
    return this.walletService.adminAdjustBalance(
      userId,
      body.amount,
      body.reason,
      adminId,
      adminEmail,
    );
  }
}
