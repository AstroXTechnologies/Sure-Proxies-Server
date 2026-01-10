import {
  BadRequestException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';
import { db } from 'src/main';
import { VirtualAccountService } from '../account/virtual/account.service';
import { AuditAction } from '../audit/audit.model';
import { AuditService } from '../audit/audit.service';
import { ProxyOrderService } from '../proxy/order/order.service';
import { TransactionsService } from '../transaction/transaction.service';
import { Wallet, WalletTransaction, WithdrawalRequest } from './wallet.model';

@Injectable()
export class WalletService {
  private walletCollection = 'wallets';
  private walletTransactionCollection = 'wallet_transactions';

  constructor(
    private transactionsService: TransactionsService,
    @Inject(forwardRef(() => ProxyOrderService))
    private proxyOrderService: ProxyOrderService,
    private virtualAccountService: VirtualAccountService,
    private auditService: AuditService,
  ) {}

  async getOrCreateWallet(userId: string): Promise<Wallet> {
    const walletSnapshot = await db
      .collection(this.walletCollection)
      .where('userId', '==', userId)
      .limit(1)
      .get();

    if (!walletSnapshot.empty) {
      const doc = walletSnapshot.docs[0];
      return doc.data() as Wallet;
    }

    // Create new wallet
    const walletId = db.collection(this.walletCollection).doc().id;
    const newWallet: Wallet = {
      id: walletId,
      userId,
      balance: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection(this.walletCollection).doc(walletId).set(newWallet);
    return newWallet;
  }

  async getBalance(userId: string): Promise<number> {
    const wallet = await this.getOrCreateWallet(userId);
    return wallet.balance;
  }

  async initiateDeposit(
    userId: string,
    amountNaira: number,
  ): Promise<{ transactionId: string; message: string }> {
    if (amountNaira <= 0) {
      throw new BadRequestException('Amount must be greater than 0');
    }

    // Ensure user has a virtual account (create if not exists)
    await this.virtualAccountService.ensureVirtualAccount(userId);

    // Wallet operates in NGN. Store deposit amounts in NGN.
    const amountNGN = Math.round(amountNaira);

    // Create a transaction record for the deposit (store amount in NGN so transaction reflects user currency)
    const transaction = await this.transactionsService.create(userId, {
      type: 'DEPOSIT',
      amount: amountNGN,
      reference: `DEPOSIT-${Date.now()}`,
    });

    // Create wallet transaction record (NGN)
    await this.createWalletTransaction({
      userId,
      type: 'DEPOSIT',
      amount: amountNGN,
      status: 'PENDING',
      description: `Wallet deposit of ₦${amountNGN}`,
      referenceId: transaction.id,
    });

    // Create a deterministic mapping from virtual account number -> transactionId
    try {
      const vSnap = await db.collection('virtual_accounts').doc(userId).get();
      if (vSnap.exists) {
        const vData = vSnap.data() as Record<string, unknown> | undefined;
        // Prefer provider-supplied customer_id on the virtual account as the mapping key
        const custObj =
          vData && typeof vData['customer'] === 'object'
            ? (vData['customer'] as Record<string, unknown>)
            : undefined;
        const customerId =
          custObj && typeof custObj['customer_id'] === 'string'
            ? custObj['customer_id']
            : undefined;

        if (customerId) {
          const key = String(customerId).trim();
          await db.collection('virtual_account_mappings').doc(key).set({
            transactionId: transaction.id,
            userId,
            key,
            amount: amountNGN,
            createdAt: new Date(),
          });
          console.log(
            '[WALLET] Created virtual account mapping for customer_id',
            key,
            '->',
            transaction.id,
          );
        }
      }
    } catch (err) {
      console.warn('[WALLET] Failed to create virtual account mapping:', err);
    }

    return {
      transactionId: transaction.id,
      message:
        'Deposit initiated. Transfer the amount (in Naira) to your virtual account to complete the deposit.',
    };
  }

  async processDeposit(
    userId: string,
    transactionId: string,
    amount: number,
  ): Promise<void> {
    // Step 1: Update transaction status to SUCCESS first
    await this.transactionsService.update(transactionId, { status: 'SUCCESS' });

    // Step 2: Update wallet balance using Firestore transaction
    const wallet = await this.getOrCreateWallet(userId);
    const walletRef = db.collection(this.walletCollection).doc(wallet.id);

    await db.runTransaction(async (transaction) => {
      const walletDoc = await transaction.get(walletRef);

      if (!walletDoc.exists) {
        throw new BadRequestException('Wallet not found');
      }

      const currentWallet = walletDoc.data() as Wallet;
      // processDeposit receives amount in NGN (webhook supplies amountPaid in NGN)
      const newBalance = currentWallet.balance + amount;

      // Update wallet balance atomically
      transaction.update(walletRef, {
        balance: newBalance,
        updatedAt: new Date(),
      });

      // Find and update wallet transaction status, or create new one
      const walletTxSnapshot = await db
        .collection(this.walletTransactionCollection)
        .where('referenceId', '==', transactionId)
        .where('type', '==', 'DEPOSIT')
        .limit(1)
        .get();

      if (!walletTxSnapshot.empty) {
        // Update existing transaction
        const doc = walletTxSnapshot.docs[0];
        transaction.update(
          db.collection(this.walletTransactionCollection).doc(doc.id),
          {
            status: 'SUCCESS',
            updatedAt: new Date(),
          },
        );
      } else {
        // Create new wallet transaction (for direct webhook cases)
        const walletTxId = db
          .collection(this.walletTransactionCollection)
          .doc().id;
        const walletTransaction = {
          id: walletTxId,
          walletId: wallet.id,
          userId,
          type: 'DEPOSIT' as const,
          amount,
          status: 'SUCCESS' as const,
          description: `Wallet deposit of ₦${amount}`,
          referenceId: transactionId,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        transaction.set(
          db.collection(this.walletTransactionCollection).doc(walletTxId),
          walletTransaction,
        );
      }
    });
  }

  async requestWithdrawal(
    userId: string,
    request: WithdrawalRequest,
  ): Promise<{ message: string; transactionId: string }> {
    if (request.amount <= 0) {
      throw new BadRequestException('Amount must be greater than 0');
    }

    const wallet = await this.getOrCreateWallet(userId);

    // Wallet balance is in NGN
    if (wallet.balance < request.amount) {
      throw new BadRequestException('Insufficient balance');
    }

    // Step 1: Create transaction record first
    // Create transaction record in NGN
    const transaction = await this.transactionsService.create(userId, {
      type: 'WITHDRAWAL',
      amount: request.amount,
      reference: `WD-${Date.now()}`,
    });

    console.log(
      `📝 [WALLET] Withdrawal transaction created: ${transaction.id}`,
    );

    // Step 2: Deduct from wallet using Firestore transaction
    const walletRef = db.collection(this.walletCollection).doc(wallet.id);

    try {
      await db.runTransaction(async (firestoreTx) => {
        const walletDoc = await firestoreTx.get(walletRef);

        if (!walletDoc.exists) {
          throw new BadRequestException('Wallet not found');
        }

        const currentWallet = walletDoc.data() as Wallet;

        // Double-check balance inside transaction (NGN)
        if (currentWallet.balance < request.amount) {
          throw new BadRequestException('Insufficient balance');
        }

        const newBalance = currentWallet.balance - request.amount;

        // Deduct from wallet atomically
        firestoreTx.update(walletRef, {
          balance: newBalance,
          updatedAt: new Date(),
        });
      });

      // Step 3: Create wallet transaction record
      await this.createWalletTransaction({
        userId,
        type: 'WITHDRAWAL',
        amount: request.amount,
        status: 'PENDING',
        description: `Withdrawal of ₦${request.amount} to ${request.bankName} - ${request.accountName}`,
        referenceId: transaction.id,
      });

      console.log(
        `✅ [WALLET] Withdrawal processed: ₦${request.amount} deducted from wallet ${wallet.id}`,
      );

      return {
        transactionId: transaction.id,
        message: `Withdrawal request for ₦${request.amount} submitted successfully. Funds will be sent to ${request.bankName} - ${request.accountName}`,
      };
    } catch (error) {
      // If wallet deduction fails, mark transaction as FAILED
      await this.transactionsService.update(transaction.id, {
        status: 'FAILED',
      });
      throw error;
    }
  }

  async deductForPurchase(
    userId: string,
    amount: number,
    description: string,
  ): Promise<string> {
    const wallet = await this.getOrCreateWallet(userId);

    // Wallet balance and amount are in NGN
    if (wallet.balance < amount) {
      throw new BadRequestException(
        'Insufficient wallet balance for this purchase',
      );
    }

    // Step 1: Create transaction record first
    // Create a transaction record indicating a purchase (store NGN amount)
    const transaction = await this.transactionsService.create(userId, {
      type: 'PURCHASE',
      amount,
      reference: `WALLET-PURCHASE-${Date.now()}`,
    });

    // Step 2: Deduct from wallet using Firestore transaction
    const walletRef = db.collection(this.walletCollection).doc(wallet.id);

    try {
      await db.runTransaction(async (firestoreTx) => {
        const walletDoc = await firestoreTx.get(walletRef);

        if (!walletDoc.exists) {
          throw new BadRequestException('Wallet not found');
        }

        const currentWallet = walletDoc.data() as Wallet;

        // Double-check balance inside transaction
        if (currentWallet.balance < amount) {
          throw new BadRequestException(
            'Insufficient wallet balance for this purchase',
          );
        }

        const newBalance = currentWallet.balance - amount;

        // Deduct from wallet atomically
        firestoreTx.update(walletRef, {
          balance: newBalance,
          updatedAt: new Date(),
        });
      });

      // Step 3: Mark transaction as SUCCESS
      await this.transactionsService.update(transaction.id, {
        status: 'SUCCESS',
      });

      // Step 4: Create wallet transaction record
      await this.createWalletTransaction({
        userId,
        type: 'PURCHASE',
        amount,
        status: 'SUCCESS',
        description: description || `Purchase deduction of ₦${amount}`,
        referenceId: transaction.id,
      });

      console.log(
        `✅ [WALLET] Purchase deducted: ₦${amount} from wallet ${wallet.id}`,
      );

      return transaction.id;
    } catch (error) {
      // If wallet deduction fails, mark transaction as FAILED
      await this.transactionsService.update(transaction.id, {
        status: 'FAILED',
      });
      throw error;
    }
  }

  async getTransactions(userId: string): Promise<WalletTransaction[]> {
    const snapshot = await db
      .collection(this.walletTransactionCollection)
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const transactions = snapshot.docs.map((doc) => {
      const data = doc.data() as WalletTransaction;

      // Convert any Firestore timestamps to proper dates
      // Safely convert dates - use current time as fallback
      const createdAt = data.createdAt ? new Date() : new Date();
      const updatedAt = data.updatedAt ? new Date() : new Date();

      return {
        ...data,
        id: doc.id,
        createdAt,
        updatedAt,
      };
    });

    return transactions;
  }

  /**
   * Refund amount back to wallet (e.g., failed purchase, cancellation)
   * Uses Firestore transaction for atomicity
   */
  async refundToWallet(
    userId: string,
    amount: number,
    description: string,
  ): Promise<string> {
    if (amount <= 0) {
      throw new BadRequestException('Refund amount must be greater than 0');
    }

    // Step 1: Create transaction record first
    const transaction = await this.transactionsService.create(userId, {
      type: 'DEPOSIT', // Refund increases balance, similar to deposit
      amount,
      reference: `REFUND-${Date.now()}`,
    });

    // Step 2: Add to wallet using Firestore transaction
    const wallet = await this.getOrCreateWallet(userId);
    const walletRef = db.collection(this.walletCollection).doc(wallet.id);

    try {
      await db.runTransaction(async (firestoreTx) => {
        const walletDoc = await firestoreTx.get(walletRef);

        if (!walletDoc.exists) {
          throw new BadRequestException('Wallet not found');
        }

        const currentWallet = walletDoc.data() as Wallet;
        const newBalance = currentWallet.balance + amount;

        // Add to wallet atomically
        firestoreTx.update(walletRef, {
          balance: newBalance,
          updatedAt: new Date(),
        });
      });

      // Step 3: Mark transaction as SUCCESS
      await this.transactionsService.update(transaction.id, {
        status: 'SUCCESS',
      });

      // Step 4: Create wallet transaction record
      await this.createWalletTransaction({
        userId,
        type: 'REFUND',
        amount,
        status: 'SUCCESS',
        description: description || `Refund of ₦${amount}`,
        referenceId: transaction.id,
      });

      return transaction.id;
    } catch (error) {
      // If wallet update fails, mark transaction as FAILED
      await this.transactionsService.update(transaction.id, {
        status: 'FAILED',
      });
      throw error;
    }
  }

  /**
   * Admin-only: Adjust wallet balance (credit or debit)
   * Positive amount = credit (add to balance)
   * Negative amount = debit (subtract from balance)
   * Creates an audit trail via wallet transaction and audit log
   */
  async adminAdjustBalance(
    userId: string,
    amount: number,
    reason: string,
    adminId: string,
    adminEmail: string,
  ): Promise<{ success: boolean; newBalance: number; transactionId: string }> {
    if (amount === 0) {
      throw new BadRequestException('Amount cannot be zero');
    }

    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('Reason is required for admin adjustments');
    }

    const wallet = await this.getOrCreateWallet(userId);
    const walletRef = db.collection(this.walletCollection).doc(wallet.id);

    // For debits, ensure sufficient balance
    if (amount < 0 && wallet.balance + amount < 0) {
      throw new BadRequestException(
        `Insufficient balance. Current: ₦${wallet.balance}, Attempted debit: ₦${Math.abs(amount)}`,
      );
    }

    // Create transaction record
    const transactionType = amount > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
    const transaction = await this.transactionsService.create(userId, {
      type: transactionType,
      amount: Math.abs(amount),
      reference: `ADMIN-ADJUST-${Date.now()}`,
    });

    try {
      let newBalance = 0;

      await db.runTransaction(async (firestoreTx) => {
        const walletDoc = await firestoreTx.get(walletRef);

        if (!walletDoc.exists) {
          throw new BadRequestException('Wallet not found');
        }

        const currentWallet = walletDoc.data() as Wallet;

        // Double-check for debits inside transaction
        if (amount < 0 && currentWallet.balance + amount < 0) {
          throw new BadRequestException('Insufficient balance');
        }

        newBalance = currentWallet.balance + amount;

        firestoreTx.update(walletRef, {
          balance: newBalance,
          updatedAt: new Date(),
        });
      });

      // Mark transaction as SUCCESS
      await this.transactionsService.update(transaction.id, {
        status: 'SUCCESS',
      });

      // Create wallet transaction record for audit
      const adjustmentType = amount > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
      await this.createWalletTransaction({
        userId,
        type: adjustmentType,
        amount: Math.abs(amount),
        status: 'SUCCESS',
        description: `[ADMIN] ${amount > 0 ? 'Credit' : 'Debit'} ₦${Math.abs(amount)} - ${reason}`,
        referenceId: transaction.id,
      });

      // Log to audit system
      await this.auditService.create({
        adminId,
        adminEmail,
        action:
          amount > 0 ? AuditAction.WALLET_CREDIT : AuditAction.WALLET_DEBIT,
        targetType: 'wallet',
        targetId: userId,
        details: {
          amount,
          reason,
          previousBalance: wallet.balance,
          newBalance,
          transactionId: transaction.id,
        },
      });

      console.log(
        `✅ [WALLET] Admin adjustment: ${amount > 0 ? '+' : ''}₦${amount} for user ${userId}. Reason: ${reason}`,
      );

      return {
        success: true,
        newBalance,
        transactionId: transaction.id,
      };
    } catch (error) {
      await this.transactionsService.update(transaction.id, {
        status: 'FAILED',
      });
      throw error;
    }
  }

  private async createWalletTransaction(
    data: Omit<
      WalletTransaction,
      'id' | 'walletId' | 'createdAt' | 'updatedAt'
    >,
  ): Promise<WalletTransaction> {
    const wallet = await this.getOrCreateWallet(data.userId);
    const id = db.collection(this.walletTransactionCollection).doc().id;

    const transaction: WalletTransaction = {
      id,
      walletId: wallet.id,
      userId: data.userId,
      type: data.type,
      amount: data.amount,
      status: data.status,
      description: data.description,
      referenceId: data.referenceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db
      .collection(this.walletTransactionCollection)
      .doc(id)
      .set(transaction);

    return transaction;
  }
}
