import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createTransport } from 'nodemailer';
import { dbAuth } from 'src/main';
import { LoginDto } from 'src/modules/auth/auth.dto';
import { AuthService } from 'src/modules/auth/auth.service';

@ApiTags('Auth Module')
@Controller('auth')
export class AuthController {
  constructor(private readonly authSvc: AuthService) {}

  @Post('login')
  @ApiOperation({
    summary: 'Login a user',
    description: 'Authenticate a user and return their information.',
  })
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiResponse({ status: 200, description: 'User logged in successfully.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authSvc.login(loginDto);
    // Create session cookie (token + role) for middleware; HttpOnly for security
    try {
      const payload = Buffer.from(
        JSON.stringify({ t: result.idToken, r: result.user.role }),
        'utf8',
      ).toString('base64');
      const twelveHoursMs = 12 * 60 * 60 * 1000;
      res.cookie('sp_auth', payload, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: twelveHoursMs,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
    } catch {
      // fail silently, login still succeeds
    }
    return result;
  }

  @Post('resend-verification')
  @ApiOperation({ summary: 'Resend email verification link' })
  @ApiResponse({
    status: 200,
    description: 'Verification link sent (or logged).',
  })
  async resendVerification(@Body() body: { email: string }) {
    const email = body?.email;
    if (!email) {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }
    try {
      // Ensure the account exists in Firebase
      await dbAuth.getUserByEmail(email);

      const actionCodeSettings = {
        url: process.env.FRONTEND_URL
          ? `${process.env.FRONTEND_URL}/signin`
          : 'http://localhost:3000/signin',
        handleCodeInApp: false,
      };

      const link = await dbAuth.generateEmailVerificationLink(
        email,
        actionCodeSettings,
      );

      const host = process.env.SMTP_HOST;
      const port = process.env.SMTP_PORT
        ? Number(process.env.SMTP_PORT)
        : undefined;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;

      if (host && port && user && pass) {
        const transporter = createTransport({
          host,
          port,
          secure: port === 465,
          auth: { user, pass },
        });
        await transporter.sendMail({
          from:
            process.env.EMAIL_FROM ||
            `no-reply@${process.env.FRONTEND_BASE_DOMAIN || 'localhost'}`,
          to: email,
          subject: 'Verify your email for Sure Proxies',
          html: `<p>Hello,</p><p>Please verify your email by clicking the link below:</p><p><a href="${link}">Verify Email</a></p><pre>${link}</pre>`,
        });
        return { success: true };
      }

      // Fallback: log link
      console.warn('⚠️ [EMAIL] SMTP not configured. Verification link: ', link);
      return { success: true, logged: true, link };
    } catch (err) {
      // Map Firebase "user not found" to 404, otherwise treat as internal error
      if (
        err?.code === 'auth/user-not-found' ||
        err?.message?.includes?.('user')
      ) {
        throw new HttpException('Account not found', HttpStatus.NOT_FOUND);
      }
      console.error('Failed to resend verification link:', err);
      throw new HttpException(
        'Unable to resend verification link',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout user (clear auth cookie)' })
  @ApiResponse({ status: 200, description: 'User logged out.' })
  logout(@Res({ passthrough: true }) res: Response) {
    try {
      res.cookie('sp_auth', '', {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 0,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
    } catch {
      // ignore
    }
    return { success: true };
  }
}
