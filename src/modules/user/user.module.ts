import { Module } from '@nestjs/common';
import { VirtualAccountModule } from 'src/modules/account/virtual/account.module';
import { AuditModule } from 'src/modules/audit/audit.module';
import { AuthModule } from 'src/modules/auth/auth.module';
import { PaymentpointModule } from 'src/modules/paymentpoint/paymentpoint.module';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  imports: [AuthModule, VirtualAccountModule, PaymentpointModule, AuditModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
