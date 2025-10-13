import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import nodemailer from 'nodemailer';
import { db, dbAuth } from 'src/main';
import { UserDoc, UserRole } from 'src/modules/user/user.model';
import { CreateUserDTO } from './user.dto';

@Injectable()
export class UserService {
  public async create(model: CreateUserDTO): Promise<UserDoc> {
    try {
      const record = await dbAuth.createUser({
        displayName: model.fullName,
        email: model.email,
        password: model.password,
      });

      if (!record) {
        throw new HttpException(
          'Unable to create account. Please try again.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      await this.saveUser(record.uid, {
        uid: record.uid,
        email: model.email,
        fullName: model.fullName,
        phoneNumber: model.phoneNumber,
        createdAt: admin.firestore.Timestamp.now(),
        lastLogin: admin.firestore.Timestamp.now(),
        purchases: [],
        role: UserRole.USER,
      } as UserDoc);

      // Attempt to send verification email (best-effort)
      try {
        await this.sendEmailVerification(record.uid, model.email);
      } catch (e) {
        console.warn('Failed to queue/send verification email:', e);
      }

      const userDoc = await db.collection('users').doc(record.uid).get();
      const data = userDoc.data() as UserDoc | undefined;

      if (!data) {
        throw new HttpException(
          'Account created but verification failed. Please contact support.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        uid: data.uid,
        email: data.email,
        fullName: data.fullName,
        phoneNumber: data.phoneNumber,
        createdAt: data.createdAt,
        lastLogin: data.lastLogin,
        purchases: data.purchases,
        role: data.role,
      };
    } catch (error: unknown) {
      console.error(error, 'Error creating user');
      throw error;
    }
  }

  /**
   * After creating a Firebase user, generate an email verification link and send it.
   * This method is safe to call in dev environments where SMTP may be absent; it will
   * log the verification link instead.
   */
  private async sendEmailVerification(uid: string, email: string) {
    try {
      // Generate Firebase email verification link
      const actionCodeSettings = {
        // Redirect back to frontend sign-in page after verification
        url: process.env.FRONTEND_URL
          ? `${process.env.FRONTEND_URL}/signin`
          : 'http://localhost:3000/signin',
        handleCodeInApp: false,
      };

      const link = await dbAuth.generateEmailVerificationLink(
        email,
        actionCodeSettings,
      );

      // If SMTP config present, attempt to send email via nodemailer
      const host = process.env.SMTP_HOST;
      const port = process.env.SMTP_PORT
        ? Number(process.env.SMTP_PORT)
        : undefined;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;

      if (host && port && user && pass) {
        const transporter = nodemailer.createTransport({
          host,
          port,
          secure: port === 465, // true for 465, false for other ports
          auth: {
            user,
            pass,
          },
        });

        const info = await transporter.sendMail({
          from:
            process.env.EMAIL_FROM ||
            `no-reply@${process.env.FRONTEND_BASE_DOMAIN || 'localhost'}`,
          to: email,
          subject: 'Verify your email for Sure Proxies',
          html: `<p>Hello,</p>
<p>Thanks for creating an account. Please verify your email by clicking the link below:</p>
<p><a href="${link}">Verify Email</a></p>
<p>If the link doesn't work, copy and paste the following URL into your browser:</p>
<pre>${link}</pre>
<p>Thanks,<br/>Sure Proxies Team</p>`,
        });

        console.log('✅ [EMAIL] Verification email sent:', info.messageId);
        return;
      }

      // Fallback: log the link (useful for development)
      console.warn('⚠️ [EMAIL] SMTP not configured. Verification link: ', link);
    } catch (err) {
      console.error('❌ [EMAIL] Failed to send verification email:', err);
      // Do not fail user creation if email sending fails - just log
    }
  }

  /**
   * Public helper to resend verification link to an email address.
   * This reuses the private sendEmailVerification method and is safe to call
   * even if SMTP is not configured (it will log the link).
   */
  public async resendVerification(email: string): Promise<void> {
    try {
      // Try to resolve a UID for the provided email if possible
      let uid: string | undefined;
      try {
        const user = await dbAuth.getUserByEmail(email);
        uid = user.uid;
      } catch (err) {
        // If user not found in Firebase, throw a not found error
        throw new HttpException('Account not found', HttpStatus.NOT_FOUND);
      }

      await this.sendEmailVerification(uid, email);
    } catch (err) {
      console.error('Error resending verification:', err);
      throw err;
    }
  }

  async saveUser(userId: string, userData: UserDoc): Promise<void> {
    try {
      const userRef = db.collection('users').doc(userId);
      // ✅ Just save the user - virtual accounts created on first purchase
      await userRef.set(userData);
    } catch (error) {
      console.error('❌ [USER] Error saving user in db:', error);
      throw new HttpException(
        'Unable to save account information. Please try again.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  public async findAll(): Promise<UserDoc[]> {
    const usersSnapshot = await db.collection('users').get();

    return usersSnapshot.docs.map((doc) => {
      const data = doc.data() as UserDoc | undefined;

      return {
        uid: data?.uid,
        email: data?.email,
        fullName: data?.fullName,
        phoneNumber: data?.phoneNumber,
        createdAt: data?.createdAt,
        lastLogin: data?.lastLogin,
        purchases: (data?.purchases as unknown[]) ?? [],
        role: data?.role ?? UserRole.USER,
      } as UserDoc;
    });
  }

  async findOne(id: string) {
    const user = await db.collection('users').doc(id).get();
    if (!user.exists) {
      throw new HttpException('Account not found', HttpStatus.NOT_FOUND);
    }
    return { id: user.id, ...user.data() };
  }

  async update(id: string, model: UserDoc) {
    const user = await this.findOne(id);
    const updatedUser = { ...user, ...model };
    await this.saveUser(id, updatedUser);
    return updatedUser;
  }

  async remove(id: string) {
    const user = await this.findOne(id);
    await db.collection('users').doc(id).delete();
    return user;
  }
}
