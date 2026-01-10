import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountModule } from 'src/modules/account/account.module';
import { VirtualAccountModule } from 'src/modules/account/virtual/account.module';
import { AuditModule } from 'src/modules/audit/audit.module';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { AuthModule } from 'src/modules/auth/auth.module';
import { PaymentpointModule } from 'src/modules/paymentpoint/paymentpoint.module';
import { ProxyOrderModule } from 'src/modules/proxy/order/order.module';
import { TransactionModule } from 'src/modules/transaction/transaction.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { WebhookModule } from 'src/modules/webhook/webhook.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProxyModule } from './modules/proxy/proxy.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    UserModule,
    AuthModule,
    ProxyModule,
    ProxyOrderModule,
    AccountModule,
    VirtualAccountModule,
    TransactionModule,
    PaymentpointModule,
    WebhookModule,
    WalletModule,
    AuditModule,
  ],
  controllers: [AppController],
  providers: [AppService, AuthGuard],
})
export class AppModule {}
