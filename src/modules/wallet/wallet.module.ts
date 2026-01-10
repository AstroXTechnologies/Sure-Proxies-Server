import { forwardRef, Module } from '@nestjs/common';
import { VirtualAccountModule } from '../account/virtual/account.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ProxyOrderModule } from '../proxy/order/order.module';
import { TransactionModule } from '../transaction/transaction.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    TransactionModule,
    AuthModule,
    VirtualAccountModule,
    AuditModule,
    forwardRef(() => ProxyOrderModule),
  ],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
