import { Module } from '@nestjs/common';
import { VirtualAccountModule } from 'src/modules/account/virtual/account.module';
import { AuthModule } from 'src/modules/auth/auth.module';
import { PaymentpointModule } from 'src/modules/paymentpoint/paymentpoint.module';
import { ProxyOrderController } from 'src/modules/proxy/order/order.controller';
import { ProxyOrderService } from 'src/modules/proxy/order/order.service';
import { TransactionModule } from 'src/modules/transaction/transaction.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';

@Module({
  imports: [
    AuthModule,
    TransactionModule,
    PaymentpointModule,
    WalletModule,
    VirtualAccountModule,
  ],
  controllers: [ProxyOrderController],
  providers: [ProxyOrderService, ProxyOrderController],
  exports: [ProxyOrderService],
})
export class ProxyOrderModule {}
