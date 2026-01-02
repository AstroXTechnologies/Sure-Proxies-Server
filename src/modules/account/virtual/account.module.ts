import { Module } from '@nestjs/common';
import { VirtualAccountController } from 'src/modules/account/virtual/account.controller';
import { AuthModule } from 'src/modules/auth/auth.module';
import { PaymentpointModule } from 'src/modules/paymentpoint/paymentpoint.module';
import { VirtualAccountService } from './account.service';

@Module({
  imports: [AuthModule, PaymentpointModule],
  controllers: [VirtualAccountController],
  providers: [VirtualAccountService, VirtualAccountController],
  exports: [VirtualAccountService],
})
export class VirtualAccountModule {}
