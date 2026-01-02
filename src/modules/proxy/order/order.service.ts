/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { DocumentSnapshot, FieldValue } from 'firebase-admin/firestore';
import { env as cfg } from 'src/config';
import { db } from 'src/main';
import { VirtualAccountService } from 'src/modules/account/virtual/account.service';
import { PaymentpointService } from 'src/modules/paymentpoint/paymentpoint.service';
import {
  FinalizeTxResult,
  PendingDataModel,
  PriceResponseModel,
  PurchaseOrderModel,
  ServiceDetailsResponseModel,
  TxDoc,
} from 'src/modules/proxy/order/order.model';
import { TransactionsService } from 'src/modules/transaction/transaction.service';
import { WalletService } from 'src/modules/wallet/wallet.service';
import { PriceInputDto, ProxyOrderPurchaseInputDto } from './order.dto';
import { ProxyOrderModel } from './order.model';

@Injectable()
export class ProxyOrderService {
  private readonly apiBaseUrl = 'https://api.proxy-cheap.com/v2/order';
  private axiosInstance?: AxiosInstance;
  private providerEnabled = false;

  /** Normalize packageId into a string if possible (accepts string, object, array) */
  private normalizePackageId(raw: any): string | null {
    if (raw == null) return null;
    // Array: pick first usable entry
    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      const first = raw[0];
      return this.normalizePackageId(first);
    }
    // Object: try common id fields
    if (typeof raw === 'object') {
      if (raw.id) return String(raw.id);
      if (raw.packageId) return String(raw.packageId);
      if (raw.value) return String(raw.value);
      // If object has a single string property, return it
      const keys = Object.keys(raw as Record<string, unknown>);
      for (const k of keys) {
        const val = (raw as Record<string, unknown>)[k];
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
      return null;
    }
    // Primitive
    const s = String(raw).trim();
    return s.length > 0 ? s : null;
  }
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly paymentPointService: PaymentpointService,
    private readonly walletService: WalletService,
    private readonly virtualAccountService: VirtualAccountService,
  ) {
    // Initialize providerEnabled and default axios instance
    const hasKey = Boolean(process.env.PROXY_CHEAP_API_KEY);
    const hasSecret = Boolean(process.env.PROXY_CHEAP_API_SECRET);
    this.providerEnabled = hasKey && hasSecret;

    const timeout = parseInt(process.env.PROXY_API_TIMEOUT || '30000', 10);
    this.axiosInstance = axios.create({
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SureProxies/1.0',
        ...(process.env.PROXY_CHEAP_API_KEY && {
          'X-Api-Key': process.env.PROXY_CHEAP_API_KEY,
        }),
        ...(process.env.PROXY_CHEAP_API_SECRET && {
          'X-Api-Secret': process.env.PROXY_CHEAP_API_SECRET,
        }),
      },
    });

    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (
          error &&
          (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED')
        ) {
          console.error('⚠️ [PROXY API] Request timeout:', {
            url: error.config?.url,
            method: error.config?.method,
            timeout: error.config?.timeout,
          });
        }
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );

    console.log(
      `🔐 [PROXY API] credentials present: key=${hasKey}, secret=${hasSecret}, providerEnabled=${this.providerEnabled}`,
    );
    console.log(`🔧 [PROXY API] Initialized with ${timeout}ms timeout`);
    if (!this.providerEnabled) {
      console.warn(
        '⚠️  [PROXY API] Missing PROXY_CHEAP_API_KEY or PROXY_CHEAP_API_SECRET in environment. Provider calls will return 503 until configured.',
      );
    }
  }

  /** Retry logic with exponential backoff */
  private async retryRequest<T>(
    requestFn: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000,
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 [PROXY API] Attempt ${attempt}/${maxRetries}`);
        return await requestFn();
      } catch (error) {
        lastError = error;

        const errAny: any = error;
        const msg = errAny?.message ? String(errAny.message) : '';
        const isTimeoutError =
          errAny?.code === 'ETIMEDOUT' ||
          errAny?.code === 'ECONNABORTED' ||
          msg.toLowerCase().includes('timeout');

        const isNetworkError =
          errAny?.code === 'ECONNREFUSED' ||
          errAny?.code === 'ENOTFOUND' ||
          errAny?.code === 'ENETUNREACH';

        // Only retry on timeout and network errors
        if ((isTimeoutError || isNetworkError) && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.warn(
            `⏳ [PROXY API] Attempt ${attempt} failed, retrying in ${delay}ms:`,
            {
              error: error.message,
              code: error.code,
            },
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Don't retry on other errors (4xx, 5xx, etc.)
        break;
      }
    }

    throw lastError;
  }

  /** Health check for Proxy API connectivity */
  async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    latency?: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      // Ensure axios instance exists before using
      this.ensureAxiosInstance();

      await this.retryRequest(
        () => this.axiosInstance!.get(this.apiBaseUrl, { timeout: 5000 }),
        1, // Only 1 attempt for health check
      );
      const latency = Date.now() - start;
      console.log(`✅ [PROXY API] Health check passed in ${latency}ms`);
      return { status: 'healthy', latency };
    } catch (error) {
      const latency = Date.now() - start;
      console.error(
        `❌ [PROXY API] Health check failed in ${latency}ms:`,
        error?.message,
      );
      return {
        status: 'unhealthy',
        latency,
        error: error?.message || 'Connection failed',
      };
    }
  }

  /** Fetch pricing config from Firestore */
  async getPricingConfig() {
    try {
      const configDoc = await db.collection('config').doc('pricing').get();
      if (!configDoc.exists) return { globalMarkup: 0, perServiceMarkup: {} };
      const config = configDoc.data();
      console.log(config, 'config from markup');
      return config;
    } catch (error) {
      console.error('Error fetching pricing config:', error);
      throw new HttpException(
        'Failed to fetch pricing configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Fetch current USD to NGN exchange rate from Firestore or external API */
  async getExchangeRate(): Promise<number> {
    // Check if cached rate exists and is less than 1 hour old
    const cacheRef = db.collection('config').doc('exchange-rate');
    const cacheSnap = await cacheRef.get();

    if (cacheSnap.exists) {
      const data = cacheSnap.data();
      if (data?.lastUpdated && data?.rate) {
        let lastUpdated: Date | null = null;
        if (data.lastUpdated instanceof Date) {
          lastUpdated = data.lastUpdated;
        } else if (
          data.lastUpdated &&
          typeof data.lastUpdated.toDate === 'function'
        ) {
          try {
            lastUpdated = (data.lastUpdated as { toDate(): Date }).toDate();
          } catch (e) {
            console.warn('Failed to convert timestamp to date:', e);
          }
        }

        if (lastUpdated && lastUpdated instanceof Date) {
          const hoursOld =
            (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60);
          if (hoursOld < 1) {
            const cachedRate = data.rate as number;
            return cachedRate;
          }
        }
      }
    }

    // Fetch new rate from external API with retry logic
    try {
      const response = await this.retryRequest(() =>
        axios.get('https://api.exchangerate-api.com/v4/latest/USD', {
          timeout: 10000, // 10 seconds timeout for exchange rate API
        }),
      );

      const rate = response.data?.rates?.NGN as number;

      if (!rate) {
        throw new Error('Exchange rate not available');
      }

      // Cache the rate
      await cacheRef.set({
        rate,
        lastUpdated: new Date(),
      });

      console.log('✅ [EXCHANGE RATE] Successfully fetched and cached:', rate);
      return rate;
    } catch (error) {
      console.error('❌ [EXCHANGE RATE] Failed to fetch after retries:', error);
      // Return fallback rate (you should set this to a reasonable default)
      return 1600; // Fallback USD to NGN rate
    }
  }

  /** Apply markup to original price */
  private applyMarkup(
    originalPrice: number,
    serviceId: string,
    config: any,
  ): number {
    const markup =
      config?.perServiceMarkup?.[serviceId] ?? config?.globalMarkup ?? 0;
    return Math.round(originalPrice * (1 + markup / 100));
  }

  /** Create default pricing config */
  async createConfig(
    globalMarkup = 0,
    perServiceMarkup: Record<string, number> = {},
  ) {
    try {
      const configRef = db.collection('config').doc('pricing');
      const configDoc = await configRef.get();
      if (configDoc.exists) {
        await configRef.update({ globalMarkup, perServiceMarkup });
        return { success: true, message: 'Config updated successfully' };
      } else {
        await configRef.set({ globalMarkup, perServiceMarkup });
        return { success: true, message: 'Config updated successfully' };
      }
    } catch (error) {
      console.error('Error creating pricing config:', error);
      throw new HttpException(
        'Failed to create pricing configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Ensure axiosInstance is initialized (lazy-init) */
  private ensureAxiosInstance() {
    if (this.axiosInstance) return;
    const timeout = parseInt(process.env.PROXY_API_TIMEOUT || '30000', 10);
    this.axiosInstance = axios.create({
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SureProxies/1.0',
        ...(process.env.PROXY_CHEAP_API_KEY && {
          'X-Api-Key': process.env.PROXY_CHEAP_API_KEY,
        }),
        ...(process.env.PROXY_CHEAP_API_SECRET && {
          'X-Api-Secret': process.env.PROXY_CHEAP_API_SECRET,
        }),
      },
    });

    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (
          error &&
          (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED')
        ) {
          console.error('⚠️ [PROXY API] Request timeout:', {
            url: error.config?.url,
            method: error.config?.method,
            timeout: error.config?.timeout,
          });
        }
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
  }

  /** Fetch all proxy services */
  async getAvailableProxiesServices(): Promise<ProxyOrderModel[]> {
    try {
      console.log('🔍 [PROXY API] Fetching available proxy services...');

      // Ensure axios instance exists before using
      this.ensureAxiosInstance();

      const response = await this.retryRequest(() =>
        this.axiosInstance!.get(this.apiBaseUrl),
      );

      const services: ProxyOrderModel[] = response?.data?.services;

      if (!services || !Array.isArray(services)) {
        throw new Error('Invalid response format: services not found');
      }

      console.log(
        `✅ [PROXY API] Successfully fetched ${services.length} services`,
      );
      return services;
    } catch (error) {
      console.error('❌ [PROXY API] Failed to fetch services:', {
        message: error.message,
        code: error.code,
        status: error.response?.status,
      });

      throw new HttpException(
        'Unable to fetch proxy services. Please try again later.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async getServiceOptions(serviceId: string, planId?: string) {
    try {
      console.log(`🔍 [PROXY API] Fetching options for service: ${serviceId}`);

      // Ensure axios instance exists before using
      this.ensureAxiosInstance();

      const response = await this.retryRequest(() =>
        this.axiosInstance!.post<ServiceDetailsResponseModel>(
          `${this.apiBaseUrl}/${serviceId}`,
          {
            planId: planId || null,
          },
        ),
      );

      console.log(
        `✅ [PROXY API] Successfully fetched options for service: ${serviceId}`,
      );
      return response.data;
    } catch (error) {
      console.error(
        `❌ [PROXY API] Failed to fetch options for service ${serviceId}:`,
        {
          message: error.message,
          code: error.code,
          status: error.response?.status,
        },
      );

      throw new HttpException(
        'Unable to fetch service options. Please try again later.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /** Get price from Proxy-Cheap API */
  async getPrice(serviceId: string, model?: PriceInputDto) {
    try {
      // Build provider-specific payload
      const payload: Record<string, unknown> = {};
      const normalizedId = serviceId.toLowerCase();

      // Ensure period unit is plural (fix frontend singular form if sent)
      if (model?.period?.unit) {
        const unit = model.period.unit as string;
        if (unit === 'day') (model.period.unit as any) = 'days';
        else if (unit === 'month') (model.period.unit as any) = 'months';
        else if (unit === 'year') (model.period.unit as any) = 'years';
      }

      // Heuristic classification: widen support without hardcoding every id
      // Rotating mobile/residential support removed — do not require traffic.
      const requiresTraffic = false;
      // Any static (non-rotating) ipv6 variant (datacenter or residential) requires packageId + period (country is optional)
      const requiresPackageCountry =
        normalizedId.includes('ipv6') &&
        normalizedId.includes('static') &&
        !normalizedId.includes('rotating');
      // Country-required services (static/dedicated mobile/residential, non-rotating, non-ipv6) now support period
      const countryRequiresPeriod =
        (normalizedId.includes('static') ||
          normalizedId.includes('dedicated')) &&
        (normalizedId.includes('mobile') ||
          normalizedId.includes('residential')) &&
        !normalizedId.includes('rotating') &&
        !normalizedId.includes('ipv6') &&
        normalizedId !== 'dedicated-mobile'; // treat dedicated-mobile separately
      // Plan-only was previously applied to dedicated-mobile, but dedicated-mobile now REQUIRES country + planId (no period)
      const requiresPlanOnly = false;

      if (normalizedId === 'dedicated-mobile') {
        // Dedicated mobile: requires planId, period (value only, no unit), and optional country
        payload.planId = model?.planId || 'dedicated';
        if (model?.period) {
          // Provider API expects only the value for dedicated-mobile (e.g., {value: 7})
          payload.period = { value: model.period.value };
        }
        if (model?.country) payload.country = model.country; // allow future optional country
      } else if (requiresTraffic) {
        if (typeof model?.traffic !== 'number') {
          throw new HttpException(
            { message: 'traffic is required for rotating pricing' },
            HttpStatus.BAD_REQUEST,
          );
        }
        payload.traffic = model.traffic;
        // Explicitly strip any period just in case it was sent
        if (payload.period) delete payload.period;
        // NOTE: Provider returns period.NOT_ALLOWED for rotating/traffic-only services.
        if (model?.country) payload.country = model.country; // some providers may accept country filter
      } else if (requiresPackageCountry) {
        // Static IPv6 variants: require packageId; country is optional for all IPv6 variants
        if (!model?.packageId) {
          throw new HttpException(
            { message: 'packageId is required for static-ipv6 service' },
            HttpStatus.BAD_REQUEST,
          );
        }
        payload.packageId = model.packageId;
        if (model?.country) {
          payload.country = model.country.toLowerCase();
        }
        if (model?.period) payload.period = model.period; // keep period if user provided
      } else if (countryRequiresPeriod) {
        // Static/dedicated mobile or residential (non-rotating, non-ipv6) now support optional country for some variants.
        if (model?.country) payload.country = model.country;
        if (model?.planId) payload.planId = model.planId;
        if (model?.quantity) payload.quantity = model.quantity; // ensure quantity present when provided
        if (model?.period) payload.period = model.period;
      } else {
        // Generic pattern (legacy): planId, quantity, period
        if (model?.planId) payload.planId = model.planId;
        if (model?.quantity) payload.quantity = model.quantity;
        if (model?.period) payload.period = model.period;
        if (model?.country) payload.country = model.country;
        if (model?.traffic) payload.traffic = model.traffic;
        if (model?.packageId) payload.packageId = model.packageId;
      }

      // Debug logging (opt-in): set DEBUG_PROXY_ORDER=1 to enable
      if (cfg.DEBUG_PROXY_ORDER === true) {
        try {
          const branch = requiresTraffic
            ? 'traffic-only'
            : requiresPackageCountry
              ? 'package+country'
              : countryRequiresPeriod
                ? 'country+period'
                : 'generic';
          const effectiveBranch = requiresPlanOnly ? 'plan-only' : branch;
          console.log(
            '[ProxyOrder:getPrice] building request',
            JSON.stringify({ serviceId, branch: effectiveBranch, payload }),
          );
        } catch (e) {
          console.warn('Debug logging failed', e);
        }
      }

      // Additional safeguard for any rotating service that slipped classification
      if (
        !requiresTraffic &&
        /rotating/.test(normalizedId) &&
        typeof model?.traffic !== 'number'
      ) {
        throw new HttpException(
          { message: 'traffic is required for rotating service' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Sanitize payload: remove null/undefined and empty objects
      Object.keys(payload).forEach((k) => {
        const value = payload[k];
        if (value == null) {
          delete payload[k];
        } else if (
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).length === 0
        ) {
          // Remove empty objects like period: {}
          console.warn(
            `⚠️ [PRICE] Removing empty object for field: ${k} in payload`,
          );
          delete payload[k];
        }
      });

      // Final defensive: remove period for any branch that should not send it
      if (requiresTraffic) {
        if ('period' in payload) delete payload.period;
      }
      // Country is now optional for all IPv6 variants (datacenter and residential)
      // No validation needed here - provider will handle missing country if required

      if (requiresTraffic && typeof payload['traffic'] !== 'number') {
        throw new HttpException(
          { message: 'traffic missing before provider request' },
          HttpStatus.BAD_REQUEST,
        );
      }

      console.log(
        `🔍 [PROXY API] Fetching price for service: ${serviceId}`,
        payload,
      );

      // Ensure axios instance exists before using
      this.ensureAxiosInstance();

      const response = await this.retryRequest(() =>
        this.axiosInstance!.post<PriceResponseModel>(
          `${this.apiBaseUrl}/${serviceId}/price`,
          payload,
        ),
      );
      const base = response?.data;
      // fetch markup config
      const pricingConfig = await this.getPricingConfig();
      const markupPercent =
        pricingConfig?.perServiceMarkup?.[serviceId] ??
        pricingConfig?.globalMarkup ??
        0;
      if (!markupPercent || markupPercent === 0) {
        return {
          ...base,
          originalFinalPrice: base.finalPrice,
          originalUnitPrice: base.unitPrice,
          markupPercent: 0,
          markupAmount: 0,
        } as PriceResponseModel & Record<string, unknown>;
      }

      const multiplier = 1 + markupPercent / 100;
      const newFinal = parseFloat((base.finalPrice * multiplier).toFixed(2));
      const newUnit = parseFloat((base.unitPrice * multiplier).toFixed(4));
      const markupAmount = parseFloat((newFinal - base.finalPrice).toFixed(2));

      return {
        ...base,
        finalPrice: newFinal,
        unitPrice: newUnit,
        priceNoDiscounts: parseFloat(
          (base.priceNoDiscounts * multiplier).toFixed(2),
        ),
        finalPriceInCurrency: newFinal,
        subtotal: parseFloat((base.subtotal * multiplier).toFixed(2)),
        originalFinalPrice: base.finalPrice,
        originalUnitPrice: base.unitPrice,
        markupPercent,
        markupAmount,
      } as PriceResponseModel & Record<string, unknown>;
    } catch (error: unknown) {
      console.error(
        `❌ [PROXY API] Failed to fetch price for service ${serviceId}:`,
        {
          message: (error as any)?.message || 'Unknown error',
          code: (error as any)?.code,
          status: (error as any)?.response?.status,
        },
      );

      if (axios.isAxiosError(error)) {
        // Handle timeout errors specifically
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          throw new HttpException(
            'Request timeout. The proxy service is currently unavailable. Please try again later.',
            HttpStatus.GATEWAY_TIMEOUT,
          );
        }

        // Handle network errors
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          throw new HttpException(
            'Unable to connect to proxy service. Please try again later.',
            HttpStatus.BAD_GATEWAY,
          );
        }

        const status = error.response?.status;
        const providerData = error.response?.data as unknown;
        // Attempt to derive a concise provider-side message
        let detail: string | undefined;
        if (providerData && typeof providerData === 'object') {
          const d: any = providerData;
          detail =
            d?.errors?.[0]?.message || d?.errors?.[0] || d?.message || d?.error;
        }

        // Additional payload context logged above on build; re-log minimal on failure if debug enabled
        if (cfg.DEBUG_PROXY_ORDER === true) {
          console.error('[ProxyOrder:getPrice] failed for', serviceId);
        }

        throw new HttpException(
          {
            message: 'Failed to fetch price',
            provider: detail || 'Unprocessable provider request',
            statusCode: status || HttpStatus.BAD_GATEWAY,
          },
          status && status >= 400 && status < 600
            ? status
            : HttpStatus.BAD_GATEWAY,
        );
      }

      console.error('Unknown error fetching price:', error);
      throw new HttpException(
        'An unexpected error occurred while fetching price. Please try again later.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async purchaseProxy(
    serviceId: string,
    model: ProxyOrderPurchaseInputDto,
  ): Promise<{ transactionId: string; amount: number }> {
    try {
      console.log('💰 [PURCHASE] Starting purchase for service:', serviceId);

      console.log(
        '🎯 [PURCHASE] Expected price from frontend:',
        model.expectedPrice,
      );

      // ✅ Ensure user has virtual account (lazy creation on first purchase)
      await this.virtualAccountService.ensureVirtualAccount(model.userId);

      // getPrice already includes markup in finalPrice
      const priced = await this.getPrice(serviceId, {
        planId: model.planId,
        quantity: model.quantity,
        period: { ...model.period },
        traffic: model.traffic,
        packageId: (model as any).packageId,
        country: model.country,
      });
      const profitPrice =
        (priced as any)?.finalPrice ?? (priced as any)?.unitPrice ?? 0;

      console.log('💵 [PURCHASE] Backend calculated price (USD):', profitPrice);

      // Store expectedPrice for validation AFTER webhook confirms payment
      if (model.expectedPrice !== undefined && model.expectedPrice !== null) {
        console.log(
          '💰 [PURCHASE] Expected price from frontend (NGN):',
          model.expectedPrice,
        );
        console.log(
          '⏳ [PURCHASE] Price validation will occur after payment confirmation in webhook',
        );
      }

      let transaction: { id: string; [key: string]: any } | null = null;

      // If paymentMethod is wallet, deduct NGN from user's wallet first
      if ((model as any).paymentMethod === 'wallet') {
        try {
          const exchangeRate = await this.getExchangeRate();
          const priceInNaira = Math.round(profitPrice * exchangeRate);
          console.log(
            '[PURCHASE] Wallet payment selected. Price in NGN:',
            priceInNaira,
          );

          // Deduct from wallet (wallet operates in NGN)
          const txId = await this.walletService.deductForPurchase(
            model.userId,
            priceInNaira,
            `Purchase for service ${serviceId}`,
          );

          // Use the wallet-created transaction as the transaction for the purchase
          transaction = { id: txId } as any;
          console.log('📝 [PURCHASE] Wallet deduction transaction:', txId);
        } catch (err) {
          console.error('❌ [PURCHASE] Wallet deduction failed:', err);
          throw new HttpException(
            'Wallet payment failed: ' + (err?.message || String(err)),
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      } else {
        try {
          transaction = await this.transactionsService.create(model.userId, {
            type: 'PURCHASE', // Proxy purchases are 'PURCHASE' type
            amount: profitPrice, // Store USD amount (for provider tracking)
            reference: crypto.randomUUID(),
          });
        } catch (error) {
          console.error('Failed to create transaction:', error);
          throw new HttpException(
            'Failed to create transaction',
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }

        console.log('📝 [PURCHASE] Transaction created:', transaction.id);
      }

      // Save pending purchase with all order details
      // Note: Filter out undefined values to avoid Firestore errors
      const options: any = {};
      if (model.quantity !== undefined) options.quantity = model.quantity;
      if (model.period !== undefined) options.period = model.period;
      if (model.autoExtend !== undefined) {
        // Normalize autoExtend to boolean for storage/provider
        const ae = model.autoExtend as any;
        if (typeof ae === 'boolean') options.autoExtend = ae;
        else if (ae && typeof ae === 'object') {
          options.autoExtend = Boolean(ae.isEnabled ?? ae.enabled ?? true);
        } else {
          options.autoExtend = Boolean(ae);
        }
      }
      if (model.traffic !== undefined) options.traffic = model.traffic;
      if ((model as any).packageId !== undefined)
        options.packageId = this.normalizePackageId((model as any).packageId);
      if (model.country !== undefined) options.country = model.country;
      if (model.ispId !== undefined) options.ispId = model.ispId;

      const pendingData: PendingDataModel = {
        userId: model.userId,
        serviceId,
        ...(model.planId && { planId: model.planId }), // Only include if defined
        pricePaid: profitPrice, // Store USD amount for proxy API
        ...(model.expectedPrice !== undefined &&
          model.expectedPrice !== null && {
            expectedPrice: model.expectedPrice,
          }), // Store for validation in webhook
        options,
      } as PendingDataModel;

      console.log(
        '💾 [PURCHASE] Pending data to save:',
        JSON.stringify(pendingData, null, 2),
      );

      if (!transaction || !transaction.id) {
        console.error(
          '❌ [PURCHASE] Transaction missing when saving pending purchase',
        );
        throw new HttpException(
          'Transaction missing',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      await db
        .collection('pending_purchases')
        .doc(transaction.id)
        .set(pendingData);

      console.log(
        '💾 [PURCHASE] Pending purchase saved for transaction:',
        transaction.id,
      );
      console.log('✨ [PURCHASE] Purchase initialization complete');

      // If payment was from wallet, finalize immediately (we already deducted NGN)
      if ((model as any).paymentMethod === 'wallet') {
        try {
          console.log(
            '🚀 [PURCHASE] Finalizing purchase immediately for wallet payment:',
            transaction.id,
          );
          // Call finalizePurchase to execute provider order
          const purchase = await this.finalizePurchase(transaction.id);
          console.log(
            '✅ [PURCHASE] Finalization result for wallet payment:',
            purchase?.id || null,
          );
        } catch (err) {
          console.error(
            '❌ [PURCHASE] Finalize failed for wallet payment:',
            err,
          );
          // Attempt to refund to wallet (best-effort)
          try {
            console.log(
              '♻️ [PURCHASE] Refunding user due to finalize failure:',
              model.userId,
            );
            await this.walletService.refundToWallet(
              model.userId,
              Math.round(profitPrice * (await this.getExchangeRate())),
              'Refund due to purchase finalization failure',
            );
          } catch (refundErr) {
            console.error(
              '❌ [PURCHASE] Refund failed after finalize error:',
              refundErr,
            );
          }
        }
      }

      return {
        transactionId: transaction.id,
        amount: profitPrice, // Return USD amount (consistent with storage)
      };
    } catch (error) {
      console.error('❌ [PURCHASE] Purchase error:', error);
      throw new HttpException(
        'Purchase initialization failed',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async finalizePurchase(transactionId: string) {
    const pendingRef = db.collection('pending_purchases').doc(transactionId);
    const txRef = db.collection('transactions').doc(transactionId);

    try {
      const result = await db.runTransaction<FinalizeTxResult>(async (t) => {
        const pendingSnap = await t.get(pendingRef);
        if (!pendingSnap.exists) {
          return { status: 'no_pending' };
        }
        const pending = pendingSnap.data() as PendingDataModel;

        // fetch transaction doc
        const txSnap = await t.get(txRef);
        if (!txSnap.exists) {
          return { status: 'no_tx' };
        }
        const txData = txSnap.data() as TxDoc;

        // If transaction already finalized (prevent duplicates)
        if (txData.finalized) {
          return { status: 'already_finalized' };
        }

        // mark transaction as finalized (so concurrent requests stop here)
        t.update(txRef, { finalized: true, finalizedAt: new Date() });

        // return pending for the outer scope to use
        return { status: 'ok', pending, txData };
      });

      if (result.status === 'no_pending') {
        console.warn('No pending purchase for transaction', transactionId);
        return null;
      }
      if (result.status === 'no_tx') {
        throw new Error(
          'Transaction doc missing for finalizePurchase: ' + transactionId,
        );
      }
      if (result.status === 'already_finalized') {
        console.log('finalizePurchase already ran for', transactionId);
        return null;
      }

      const { pending } = result;

      // ✅ Validate price if expectedPrice was provided (after payment confirmation)
      if (
        pending.expectedPrice !== undefined &&
        pending.expectedPrice !== null
      ) {
        console.log('🔍 [FINALIZE] Starting price validation after payment...');

        // Get exchange rate to convert USD to Naira
        const exchangeRate = await this.getExchangeRate();

        // Convert USD price to Naira
        const priceInNaira = Math.round(pending.pricePaid * exchangeRate);

        const priceDiff = Math.abs(priceInNaira - pending.expectedPrice);
        const tolerance = Math.max(priceInNaira * 0.01, 100); // 1% or 100 NGN

        console.log('💱 [FINALIZE] Exchange rate (USD to NGN):', exchangeRate);
        console.log('💵 [FINALIZE] Price paid (USD):', pending.pricePaid);
        console.log('💵 [FINALIZE] Price paid (NGN):', priceInNaira);
        console.log(
          '📌 [FINALIZE] Expected price (NGN):',
          pending.expectedPrice,
        );
        console.log('📊 [FINALIZE] Difference (NGN):', priceDiff);
        console.log('📏 [FINALIZE] Tolerance (NGN):', tolerance);

        if (priceDiff > tolerance) {
          console.error('❌ [FINALIZE] Price mismatch detected after payment!');
          console.error(
            '⚠️  [FINALIZE] This indicates a serious issue - payment already made',
          );

          // Log to transaction for investigation
          await db
            .collection('transactions')
            .doc(transactionId)
            .update({
              priceValidationFailed: true,
              priceValidationDetails: {
                pricePaidUSD: pending.pricePaid,
                pricePaidNGN: priceInNaira,
                expectedNGN: pending.expectedPrice,
                difference: priceDiff,
                tolerance,
                exchangeRate,
              },
            });

          throw new HttpException(
            {
              message:
                'Price validation failed after payment - contact support',
              currentPrice: priceInNaira,
              expectedPrice: pending.expectedPrice,
              code: 'PRICE_VALIDATION_FAILED_AFTER_PAYMENT',
            },
            HttpStatus.CONFLICT,
          );
        }

        console.log('✅ [FINALIZE] Price validation passed');
      }

      // Execute the external proxy API (outside transaction)
      // Build payload, only including defined values
      const executePayload: any = {};

      // Map pending fields to provider expected schema
      if (pending.planId !== undefined) executePayload.planId = pending.planId;
      if (pending.options.quantity !== undefined)
        executePayload.quantity = pending.options.quantity;

      // Provider typically expects period as { unit: 'months'|'days'|'years', value: number }
      if (pending.options.period !== undefined) {
        const p = pending.options.period;
        // If frontend stored period as {value, unit} keep as-is. If only value provided, default unit to 'months'.
        if (p && typeof p === 'object' && 'value' in p) {
          executePayload.period = p;
        } else if (typeof p === 'number') {
          executePayload.period = { value: p, unit: 'months' };
        } else {
          // Fallback: attempt to coerce
          try {
            const parsed = JSON.parse(String(p));
            if (parsed && parsed.value) executePayload.period = parsed;
          } catch {
            // ignore and let provider validate
            executePayload.period = p;
          }
        }
      }

      // Ensure autoExtend is a boolean (provider may reject {isEnabled: true} shape)
      if (pending.options.autoExtend !== undefined) {
        const ae = pending.options.autoExtend as any;
        if (typeof ae === 'boolean') executePayload.autoExtend = ae;
        else if (ae && typeof ae === 'object') {
          // Support legacy { isEnabled: boolean } or { enabled: boolean }
          if (ae.isEnabled !== undefined) {
            executePayload.autoExtend = Boolean(ae.isEnabled);
          } else if (ae.enabled !== undefined) {
            executePayload.autoExtend = Boolean(ae.enabled);
          } else {
            executePayload.autoExtend = Boolean(ae);
          }
        } else {
          executePayload.autoExtend = Boolean(ae);
        }
      }

      if (pending.options.traffic !== undefined)
        executePayload.traffic = pending.options.traffic;
      if (pending.options.country !== undefined)
        executePayload.country = pending.options.country;
      if (pending.options.ispId !== undefined)
        executePayload.ispId = pending.options.ispId;

      // Normalize and validate packageId: provider returns IS_BLANK when missing
      if ((pending.options as any).packageId !== undefined) {
        const pkg = this.normalizePackageId((pending.options as any).packageId);
        if (!pkg) {
          throw new HttpException(
            { message: 'packageId is required', code: 'IS_BLANK' },
            HttpStatus.BAD_REQUEST,
          );
        }
        executePayload.packageId = pkg;
      }

      console.log(
        '🚀 [FINALIZE] Execute payload:',
        JSON.stringify(executePayload, null, 2),
      );

      console.log('🚀 [FINALIZE] Executing proxy purchase with provider...');
      this.ensureAxiosInstance();

      const executeResponse = await this.retryRequest(() =>
        this.axiosInstance!.post<Record<string, unknown>>(
          `${this.apiBaseUrl}/${pending.serviceId}/execute`,
          executePayload,
          {
            headers: {
              'X-Api-Key': process.env.PROXY_CHEAP_API_KEY as string,
              'X-Api-Secret': process.env.PROXY_CHEAP_API_SECRET as string,
            },
          },
        ),
      );

      // construct and save purchase
      // Build purchase object but omit undefined fields (Firestore rejects undefined)
      const purchase: PurchaseOrderModel = {
        id: '',
        userId: pending.userId,
        serviceId: pending.serviceId,
        // planId is optional; only include when defined
        ...(pending.planId !== undefined && { planId: pending.planId }),
        profitPrice: pending.pricePaid,
        status: 'active',
        createdAt: new Date(),
        details: executeResponse.data,
      } as PurchaseOrderModel;

      const purchaseRef = await db.collection('purchases').add(purchase);
      purchase.id = purchaseRef.id;

      // Update purchase document with its own ID
      await purchaseRef.update({ id: purchaseRef.id });

      // attach purchase id to user document using FieldValue
      await db
        .collection('users')
        .doc(pending.userId)
        .update({
          purchases: FieldValue.arrayUnion(purchaseRef.id) as any,
        });

      // Map provider order id (if present) to our userId so we can claim ownership later
      try {
        const providerId =
          (executeResponse.data && (executeResponse.data as any).id) ||
          (executeResponse.data as any).orderId ||
          null;

        if (providerId) {
          // Only set defined fields to avoid Firestore undefined errors
          const mappingData: Record<string, unknown> = {
            userId: pending.userId,
            purchaseId: purchaseRef.id,
            serviceId: pending.serviceId,
            providerPayload: executeResponse.data || null,
            createdAt: new Date(),
          };

          await db
            .collection('provider_order_mappings')
            .doc(String(providerId))
            .set(mappingData);

          // Auto-claim: attach providerOrderId and payload to the purchase document
          try {
            await purchaseRef.set(
              {
                providerOrderId: String(providerId),
                providerPayload: executeResponse.data || null,
                updatedAt: new Date(),
              },
              { merge: true },
            );
            console.log(
              '✅ [AUTO-CLAIM] Attached providerOrderId to purchase:',
              purchaseRef.id,
            );
          } catch (claimErr) {
            console.error(
              '❌ [AUTO-CLAIM] Failed to attach providerOrderId to purchase:',
              claimErr,
            );
          }

          console.log(
            '✅ [MAPPING] Mapped provider order id to user:',
            providerId,
          );

          // Auto-claim: attach provider id and payload directly to the purchase document
          try {
            await purchaseRef.set(
              {
                providerOrderId: String(providerId),
                providerPayload: executeResponse.data || null,
                updatedAt: new Date(),
              },
              { merge: true },
            );
            console.log(
              '✅ [AUTO-CLAIM] Attached providerOrderId to purchase:',
              purchaseRef.id,
            );
          } catch (attachErr) {
            console.error(
              '❌ [AUTO-CLAIM] Failed to attach provider id to purchase:',
              attachErr,
            );
          }
        } else {
          console.warn(
            '⚠️ [MAPPING] No provider id found in execute response, skipping provider mapping',
          );
        }
      } catch (mapErr) {
        console.error(
          '❌ [MAPPING] Failed to save provider mapping for purchase',
          purchaseRef.id,
          mapErr,
        );
      }

      // Delete pending purchase
      await pendingRef.delete();

      console.log('Purchase finalized successfully:', purchaseRef.id);
      return purchase;
    } catch (err: unknown) {
      console.error('finalizePurchase error for', transactionId, err);

      // Capture provider response body when available (helps debug 422)
      const providerData = (err as any)?.response?.data;
      const msg = (err instanceof Error ? err.message : String(err)).slice(
        0,
        500,
      );

      try {
        await db
          .collection('transactions')
          .doc(transactionId)
          .update({
            finalizeError: msg,
            finalizeErrorProviderBody: providerData || null,
            finalized: false,
            finalizedAt: new Date(),
          });
      } catch (dbErr) {
        console.error(
          'Failed to record finalize error in transaction doc:',
          dbErr,
        );
      }

      throw err;
    }
  }

  /** Get all purchases for a user */
  async getUserPurchases(userId: string): Promise<PurchaseOrderModel[]> {
    const purchasesSnap = await db
      .collection('purchases')
      .where('userId', '==', userId)
      .get();
    return purchasesSnap.docs.map((doc) => doc.data() as PurchaseOrderModel);
  }

  /** Get purchases for a user that are expiring soon (active, expires in <= 7 days) */
  async getExpiringSoonPurchases(
    userId: string,
  ): Promise<PurchaseOrderModel[]> {
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const purchasesSnap = await db
      .collection('purchases')
      .where('userId', '==', userId)
      .where('status', '==', 'active')
      .get();
    return purchasesSnap.docs
      .map((doc) => doc.data() as PurchaseOrderModel)
      .filter((p) => {
        if (!p.details || !p.details.expiresAt) return false;
        const exp = new Date(p.details.expiresAt as string);
        return exp > now && exp <= soon;
      });
  }

  /** Get purchases for a user that are inactive (expired) */
  async getInactivePurchases(userId: string): Promise<PurchaseOrderModel[]> {
    const purchasesSnap = await db
      .collection('purchases')
      .where('userId', '==', userId)
      .where('status', '==', 'expired')
      .get();
    return purchasesSnap.docs.map((doc) => doc.data() as PurchaseOrderModel);
  }

  /** Get total spent by a user (sum of profitPrice for all purchases) */
  /** Get total spent by a user (returns amount in NGN).
   * Notes:
   * - purchases store `profitPrice` in USD (provider price). This method
   *   sums the stored USD values and converts the total to NGN using the
   *   configured exchange rate (from getExchangeRate()).
   * - We return a rounded NGN integer to match frontend expectations.
   */
  async getTotalSpent(userId: string): Promise<number> {
    const purchasesSnap = await db
      .collection('purchases')
      .where('userId', '==', userId)
      .get();

    // Sum USD amounts (profitPrice) stored on each purchase
    const totalUsd = purchasesSnap.docs
      .map((doc) => doc.data() as PurchaseOrderModel)
      .reduce((sum, p) => sum + (Number(p.profitPrice) || 0), 0);

    // Convert to NGN using cached/external exchange rate
    const exchangeRate = await this.getExchangeRate(); // NGN per 1 USD
    const totalNgn = Math.round(totalUsd * exchangeRate);
    return totalNgn;
  }

  /** Admin: Get all purchases */
  async getAllPurchases(): Promise<PurchaseOrderModel[]> {
    const purchasesSnap = await db.collection('purchases').get();
    return purchasesSnap.docs.map((doc) => doc.data() as PurchaseOrderModel);
  }

  /** Admin: List provider -> user mappings (recent first). Optional limit */
  async getProviderMappings(limit?: number) {
    try {
      let q: any = db
        .collection('provider_order_mappings')
        .orderBy('createdAt', 'desc');

      // limit and get are dynamic Firestore query calls - narrow with casts
      if (limit && limit > 0) q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map((doc: unknown) => {
        const docSnap = doc as DocumentSnapshot<Record<string, unknown>>;
        // Use the DocumentSnapshot.data() accessor when available; it
        // returns the document's data (or undefined). This is typed and
        // avoids unsafe calls of any-typed values.
        const dataObj = (
          typeof docSnap.data === 'function'
            ? docSnap.data()
            : (docSnap as any).data
        ) as Record<string, unknown> | undefined;

        return {
          id: (docSnap as any).id,
          ...(dataObj || {}),
        } as Record<string, unknown>;
      });
    } catch (error) {
      console.error('Error fetching provider mappings:', error);
      throw new HttpException(
        'Failed to fetch provider mappings',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Admin: Get a provider mapping by provider id */
  async getProviderMapping(providerId: string) {
    try {
      const doc = await db
        .collection('provider_order_mappings')
        .doc(String(providerId))
        .get();

      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error fetching provider mapping:', error);
      throw new HttpException(
        'Failed to fetch provider mapping',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Admin: Claim a provider mapping - mark as claimed by admin user */
  async claimProviderMapping(providerId: string, adminUserId: string) {
    try {
      const ref = db
        .collection('provider_order_mappings')
        .doc(String(providerId));
      const snap = await ref.get();
      if (!snap.exists) {
        throw new HttpException(
          'Provider mapping not found',
          HttpStatus.NOT_FOUND,
        );
      }

      const existing = snap.data() as any;

      const now = new Date();
      await ref.set(
        {
          claimed: true,
          claimedBy: adminUserId,
          claimedAt: now,
        },
        { merge: true },
      );

      // If mapping references a purchase, attach provider id and payload to that purchase
      try {
        const purchaseId = existing?.purchaseId;
        if (purchaseId) {
          const purchaseRef = db
            .collection('purchases')
            .doc(String(purchaseId));
          await purchaseRef.set(
            {
              providerOrderId: String(providerId),
              providerPayload: existing?.providerPayload || null,
              updatedAt: now,
            },
            { merge: true },
          );
          console.log(
            '✅ [CLAIM] Attached provider id to purchase:',
            purchaseId,
          );
        }
      } catch (attachErr) {
        console.error(
          '❌ [CLAIM] Failed to attach provider id to purchase:',
          attachErr,
        );
      }

      const updated = await ref.get();
      return { id: updated.id, ...updated.data() };
    } catch (error) {
      console.error('Error claiming provider mapping:', error);
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to claim provider mapping',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Admin: Update markup */
  async updateMarkup(
    globalMarkup: number,
    perServiceMarkup: Record<string, number>,
  ) {
    try {
      await db
        .collection('config')
        .doc('pricing')
        .set({ globalMarkup, perServiceMarkup }, { merge: true });
      return { success: true };
    } catch (error) {
      console.error('Error updating markup:', error);
      throw new HttpException(
        'Failed to update pricing configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
