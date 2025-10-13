import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import axios from 'axios';
import { Request } from 'express';
import * as admin from 'firebase-admin';
import { db, dbAuth } from 'src/main';
import { TokenResponse } from 'src/modules/auth/auth.model';
import { UserDoc, UserModel, UserRole } from '../user/user.model';
import { LoginDto } from './auth.dto';

function extractFirebaseErrorMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  // Narrow the shape safely instead of using `any`
  const candidate = err as { response?: unknown; error?: unknown };

  // Check axios-style response: response?.data?.error?.message
  if (candidate.response && typeof candidate.response === 'object') {
    const resp = candidate.response as { data?: unknown };
    if (resp.data && typeof resp.data === 'object') {
      const data = resp.data as { error?: unknown };
      if (data.error && typeof data.error === 'object') {
        const message = (data.error as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      }
    }
  }
}

@Injectable()
export class AuthService {
  async login(model: LoginDto): Promise<TokenResponse> {
    const { email, password } = model;
    try {
      const { idToken, localId, refreshToken, expiresIn } =
        await this.signInWithEmailAndPassword(email, password);

      // Ensure email is verified in Firebase before issuing session
      try {
        const firebaseUser = await dbAuth.getUser(localId);
        if (!firebaseUser.emailVerified) {
          // Send a clear error object so frontend can detect this state
          throw new UnauthorizedException({
            message: 'Email not verified',
            code: 'EMAIL_NOT_VERIFIED',
          });
        }
      } catch (e) {
        // If the thrown error is our UnauthorizedException, rethrow it
        if (e instanceof UnauthorizedException) throw e;
        // Otherwise ignore — sign-in already succeeded and we'll continue
      }

      // Fetch or create Firestore user document
      let userDocSnap = await db.collection('users').doc(localId).get();
      if (!userDocSnap.exists) {
        const firebaseUser = await dbAuth.getUser(localId);
        const newUserDoc: UserDoc = {
          uid: localId,
          email: firebaseUser.email ?? email,
          fullName: firebaseUser.displayName ?? firebaseUser.email ?? '',
          phoneNumber: firebaseUser.phoneNumber ?? '',
          createdAt: admin.firestore.Timestamp.now(),
          lastLogin: admin.firestore.Timestamp.now(),
          purchases: [],
          role: UserRole.USER,
        };
        await db.collection('users').doc(localId).set(newUserDoc);
        userDocSnap = await db.collection('users').doc(localId).get();
      } else {
        // Update lastLogin timestamp
        await db
          .collection('users')
          .doc(localId)
          .update({ lastLogin: admin.firestore.Timestamp.now() });
        userDocSnap = await db.collection('users').doc(localId).get();
      }

      const raw = userDocSnap.data() as UserDoc;
      const userModel: UserModel = {
        uid: raw.uid,
        email: raw.email,
        fullName: raw.fullName,
        phoneNumber: raw.phoneNumber,
        createdAt: raw.createdAt.toMillis(),
        lastLogin: raw.lastLogin.toMillis(),
        purchases: raw.purchases || [],
        role: raw.role,
      };

      return {
        idToken,
        refreshToken,
        expiresIn,
        localId,
        displayName: userModel.fullName || userModel.email,
        user: userModel,
      };
    } catch (err) {
      const firebaseMsg = extractFirebaseErrorMessage(err);
      if (
        firebaseMsg === 'INVALID_PASSWORD' ||
        firebaseMsg === 'EMAIL_NOT_FOUND'
      ) {
        throw new UnauthorizedException('Invalid email or password');
      }
      if (firebaseMsg === 'USER_DISABLED') {
        throw new UnauthorizedException('User account disabled');
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private async signInWithEmailAndPassword(
    email: string,
    password: string,
  ): Promise<{
    idToken: string;
    localId: string;
    refreshToken: string;
    expiresIn: string;
  }> {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`;
    return await this.sendPostRequest(url, {
      email,
      password,
      returnSecureToken: true,
    });
  }

  private async sendPostRequest<T>(url: string, data: any): Promise<T> {
    try {
      const response = await axios.post<T>(url, data, {
        headers: {
          'Content-Type': 'application/json',
        },
      });
      return response.data;
    } catch (err: unknown) {
      const firebaseMsg = extractFirebaseErrorMessage(err);
      if (firebaseMsg) {
        // Map some frequent Firebase auth errors
        switch (firebaseMsg) {
          case 'INVALID_PASSWORD':
          case 'EMAIL_NOT_FOUND':
            throw new UnauthorizedException('Invalid email or password');
          case 'USER_DISABLED':
            throw new UnauthorizedException('User account disabled');
          case 'INVALID_EMAIL':
            throw new BadRequestException('Invalid email format');
          default:
            throw new UnauthorizedException('Authentication failed');
        }
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  async validateRequest(req: Request): Promise<boolean> {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException('Authorization header missing');
    }

    const [bearer, token] = authHeader.split(' ');

    if (bearer !== 'Bearer' || !token) {
      throw new UnauthorizedException(
        "Invalid authorization format. Use 'Bearer <token>'",
      );
    }

    try {
      const decodedToken = await dbAuth.verifyIdToken(token);
      const userDoc = await db.collection('users').doc(decodedToken.uid).get();

      if (!userDoc.exists) {
        throw new UnauthorizedException('User not found');
      }

      const docData = userDoc.data() as { role?: string } | undefined;
      const userData = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        role: docData?.role ?? 'user',
      };

      (req as unknown as { user: typeof userData }).user = userData;
      return true;
    } catch (err: unknown) {
      const error = err as any;
      console.error('Error verifying token: ', error);

      // Check if token is expired
      if (
        error?.errorInfo?.code === 'auth/id-token-expired' ||
        error?.code === 'auth/id-token-expired'
      ) {
        throw new UnauthorizedException({
          message: 'Token expired',
          code: 'TOKEN_EXPIRED',
          statusCode: 401,
        });
      }

      // Check if token is revoked
      if (
        error?.errorInfo?.code === 'auth/id-token-revoked' ||
        error?.code === 'auth/id-token-revoked'
      ) {
        throw new UnauthorizedException({
          message: 'Token revoked',
          code: 'TOKEN_REVOKED',
          statusCode: 401,
        });
      }

      throw new UnauthorizedException({
        message: 'Invalid or expired token',
        code: 'TOKEN_INVALID',
        statusCode: 401,
      });
    }
  }
}
