/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { db } from 'src/main';
import { VirtualAccountResponse } from 'src/modules/account/virtual/account.model';
import { PaymentpointService } from 'src/modules/paymentpoint/paymentpoint.service';

@Injectable()
export class VirtualAccountService {
  constructor(private readonly paymentPointService: PaymentpointService) {}

  /**
   * Normalize phone number to 11 digits (Nigerian format)
   * e.g. 2348012345678 -> 08012345678
   * e.g. +2348012345678 -> 08012345678
   */
  private normalizePhoneNumber(phone: string): string {
    // Remove all non-digits
    let cleaned = phone.replace(/\D/g, '');

    // Handle 234 prefix
    if (cleaned.startsWith('234') && cleaned.length === 13) {
      cleaned = '0' + cleaned.substring(3);
    }

    // Identify if it's too long (common error: 081999999999 -> 12 digits)
    // If it starts with 0 and is > 11 digits, trim the excess from the end?
    // Or just take the last 10 digits and prepend 0?
    // Safe bet: if 12 digits and starts with 0, maybe user typed extra.
    // For now, let's try to ensure it fits the format 0[789][01]... (standard NG mobile)

    // Strict 11 digit enforcement if possible
    if (cleaned.length > 11 && cleaned.startsWith('0')) {
      // Take first 11
      cleaned = cleaned.substring(0, 11);
    }

    return cleaned;
  }

  async saveVirtualAccount(
    userId: string,
    userData: VirtualAccountResponse,
  ): Promise<void> {
    const accountRef = db.collection('virtual_accounts').doc(userId);
    await accountRef.set(userData);
  }

  async getVirtualAccountByUserId(
    userId: string,
  ): Promise<VirtualAccountResponse | null> {
    const accountRef = db.collection('virtual_accounts').doc(userId);
    const doc = await accountRef.get();
    return doc.exists ? (doc.data() as VirtualAccountResponse) : null;
  }

  /**
   * Ensure user has virtual account (create if not exists)
   *
   * NOTE: Virtual accounts are now created during user registration (user.service.ts).
   * This method serves as a FALLBACK safety net for:
   * - Users created before this feature was implemented
   * - Cases where registration-time creation failed
   * - Manual user creation scenarios
   *
   * This implements lazy creation with race condition protection via Firestore transaction
   *
   * @param userId - The user ID to create/verify virtual account for
   * @throws HttpException if user not found or creation fails
   */
  async ensureVirtualAccount(userId: string): Promise<void> {
    try {
      const virtualAccountRef = db.collection('virtual_accounts').doc(userId);

      // Use Firestore transaction to prevent race conditions
      const result = await db.runTransaction(async (transaction) => {
        const virtualAccountSnap = await transaction.get(virtualAccountRef);

        if (virtualAccountSnap.exists) {
          const data = virtualAccountSnap.data();
          const hasBankAccounts =
            data &&
            Array.isArray(data.bankAccounts) &&
            data.bankAccounts.length > 0;

          if (hasBankAccounts) {
            console.log(
              '✅ [VIRTUAL ACCOUNT] User already has valid virtual account:',
              userId,
            );
            return { alreadyExists: true };
          }
          console.warn(
            '⚠️ [VIRTUAL ACCOUNT] User has virtual account but it is missing bank details. Recreating...',
            userId,
          );
          // If invalid/empty, we proceed to overwrite it
        }

        console.log(
          '📝 [VIRTUAL ACCOUNT] No virtual account found, will create for user:',
          userId,
        );

        // Get user details within transaction to ensure consistency
        const userRef = db.collection('users').doc(userId);
        const userSnap = await transaction.get(userRef);
        const userData = userSnap.data();

        if (!userData) {
          console.error(
            '❌ [VIRTUAL ACCOUNT] User not found in Firestore for userId:',
            userId,
          );
          throw new HttpException('User not found', HttpStatus.NOT_FOUND);
        }

        // Validate required fields
        const email =
          userData.email && typeof userData.email === 'string'
            ? userData.email.trim()
            : null;
        const fullName =
          userData.fullName && typeof userData.fullName === 'string'
            ? userData.fullName.trim()
            : null;
        const phoneNumber =
          userData.phoneNumber && typeof userData.phoneNumber === 'string'
            ? userData.phoneNumber.trim()
            : null;

        if (!email || !fullName) {
          console.error('❌ [VIRTUAL ACCOUNT] Missing required user fields:', {
            userId,
            hasEmail: !!email,
            hasFullName: !!fullName,
            hasPhone: !!phoneNumber,
          });
          throw new HttpException(
            'User profile incomplete. Please update your email and full name.',
            HttpStatus.BAD_REQUEST,
          );
        }

        // Reserve the spot by writing a placeholder (prevents concurrent creation)
        transaction.set(virtualAccountRef, {
          userId,
          status: 'creating',
          createdAt: new Date(),
        });

        return {
          alreadyExists: false,
          userData: { email, fullName, phoneNumber },
        };
      });

      // If already exists, we're done
      if (result.alreadyExists) {
        return;
      }

      // Normalize phone number outside transaction to keep it clean
      // We use the one from DB, but formatted
      const formattedPhone = this.normalizePhoneNumber(
        result.userData?.phoneNumber || '',
      );

      // Create virtual account via PaymentPoint API (outside transaction)
      // This can be retried if it fails
      let virtualAccount: Record<string, unknown> | null = null;

      // Retry logic for transient failures
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(
            `🔄 [VIRTUAL ACCOUNT] Creating account (attempt ${attempt}/${maxRetries}) for user:`,
            userId,
          );

          virtualAccount = (await this.paymentPointService.createVirtualAccount(
            {
              email: result.userData!.email,
              name: result.userData!.fullName,
              phoneNumber: formattedPhone, // Use validated phone
            },
          )) as Record<string, unknown>;

          // Verify we got valid data back
          if (
            !virtualAccount ||
            typeof virtualAccount !== 'object' ||
            !('bankAccounts' in virtualAccount) ||
            !Array.isArray((virtualAccount as any).bankAccounts) ||
            (virtualAccount as any).bankAccounts.length === 0
          ) {
            console.error(
              `❌ [VIRTUAL ACCOUNT] PaymentPoint returned invalid data (attempt ${attempt}/${maxRetries}):`,
              virtualAccount ? JSON.stringify(virtualAccount) : 'null',
            );
            // Treat as an error
            const invalidDataError: any = new Error(
              'PaymentPoint returned invalid data (missing or empty bankAccounts)',
            );
            invalidDataError.code = 'INVALID_API_RESPONSE';
            invalidDataError.response = { status: 502 }; // Bad Gateway equivalent
            throw invalidDataError;
          }

          console.log(
            '✅ [VIRTUAL ACCOUNT] PaymentPoint API success:',
            JSON.stringify(virtualAccount, null, 2),
          );
          break; // Success, exit retry loop
        } catch (apiError: any) {
          console.error(
            `❌ [VIRTUAL ACCOUNT] PaymentPoint API error (attempt ${attempt}/${maxRetries}):`,
            {
              message: apiError?.message || 'Unknown error',
              status: apiError?.response?.status,
              data: apiError?.response?.data,
            },
          );

          // Only retry on network/timeout errors, not on validation errors
          const isRetryable =
            apiError?.code === 'ECONNABORTED' ||
            apiError?.code === 'ETIMEDOUT' ||
            apiError?.code === 'ECONNREFUSED' ||
            apiError?.response?.status >= 500;

          if (!isRetryable || attempt === maxRetries) {
            // Clean up placeholder on final failure
            await virtualAccountRef.delete();
            const statusCode: number =
              typeof apiError?.response?.status === 'number'
                ? apiError.response.status
                : HttpStatus.BAD_GATEWAY;
            throw new HttpException(
              `Failed to create virtual account: ${apiError?.message || 'PaymentPoint API error'}`,
              statusCode,
            );
          }

          // Exponential backoff: 1s, 2s, 4s
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
          );
        }
      }

      // Update with actual virtual account data
      try {
        console.log(
          '📋 [VIRTUAL ACCOUNT] PaymentPoint response structure:',
          JSON.stringify(virtualAccount, null, 2),
        );

        const toSave: Record<string, unknown> = {
          userId,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(virtualAccount || {}),
        };

        await virtualAccountRef.set(toSave);
        console.log(
          '✅ [VIRTUAL ACCOUNT] Virtual account created and saved for user:',
          userId,
        );
      } catch (dbError: any) {
        console.error(
          '❌ [VIRTUAL ACCOUNT] Error saving virtual account to Firestore:',
          {
            userId,
            error: dbError?.message || 'Unknown error',
          },
        );
        // Try to clean up
        await virtualAccountRef.delete().catch(() => {});
        throw new HttpException(
          'Failed to save virtual account',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } catch (error: any) {
      // Only log if not already an HttpException (avoid double-logging)
      if (!(error instanceof HttpException)) {
        console.error('❌ [VIRTUAL ACCOUNT] Unexpected error:', {
          userId,
          error: error?.message || 'Unknown error',
        });
        throw new HttpException(
          'Failed to create virtual account',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      throw error;
    }
  }
}
