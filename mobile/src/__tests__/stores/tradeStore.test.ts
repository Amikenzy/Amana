import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useAuthStore } from '../../stores/authStore';
import { useTradeStore } from '../../stores/tradeStore';
import { tradeApi } from '../../api/trade';
import { authorizeSensitiveAction } from '../../services/biometric.service';
import { signStellarTransaction } from '../../services/stellar-wallet-connect.service';

jest.mock('../../api/trade', () => ({
  tradeApi: {
    deposit: jest.fn(),
    releaseFunds: jest.fn(),
    submitSignedTransaction: jest.fn(),
  },
}));

jest.mock('../../services/biometric.service', () => ({
  authorizeSensitiveAction: jest.fn(),
}));

jest.mock('../../services/stellar-wallet-connect.service', () => ({
  signStellarTransaction: jest.fn(),
}));

const buyerAddress = 'GBUYER123456789012345678901234567890123456789012345678';
const mockTradeApi = tradeApi as jest.Mocked<typeof tradeApi>;
const mockAuthorize = authorizeSensitiveAction as jest.MockedFunction<
  typeof authorizeSensitiveAction
>;
const mockSignTransaction = signStellarTransaction as jest.MockedFunction<
  typeof signStellarTransaction
>;

describe('tradeStore Stellar transaction actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ walletAddress: buyerAddress });
    useTradeStore.setState({
      trades: [],
      total: 0,
      currentTrade: null,
      lastTransactionSubmission: null,
      isLoading: false,
      error: null,
    });
    mockAuthorize.mockResolvedValue(true);
    mockSignTransaction.mockResolvedValue('signed-xdr');
    mockTradeApi.submitSignedTransaction.mockResolvedValue({
      hash: 'transaction-hash',
      status: 'PENDING',
    });
  });

  it('signs and submits the unsigned XDR returned by the deposit API', async () => {
    mockTradeApi.deposit.mockResolvedValue({ unsignedXdr: 'deposit-unsigned-xdr' });

    await useTradeStore.getState().deposit('trade-1', jest.fn());

    expect(mockSignTransaction).toHaveBeenCalledWith(
      'deposit-unsigned-xdr',
      buyerAddress,
      expect.any(Function),
    );
    expect(mockTradeApi.submitSignedTransaction).toHaveBeenCalledWith(
      'trade-1',
      'signed-xdr',
    );
    expect(useTradeStore.getState().error).toBeNull();
    expect(useTradeStore.getState().lastTransactionSubmission).toEqual({
      hash: 'transaction-hash',
      status: 'PENDING',
    });
  });

  it('signs and submits the unsigned XDR returned by the release API', async () => {
    mockTradeApi.releaseFunds.mockResolvedValue({ unsignedXdr: 'release-unsigned-xdr' });

    await useTradeStore.getState().releaseFunds('trade-1', jest.fn());

    expect(mockSignTransaction).toHaveBeenCalledWith(
      'release-unsigned-xdr',
      buyerAddress,
      expect.any(Function),
    );
    expect(mockTradeApi.submitSignedTransaction).toHaveBeenCalledWith(
      'trade-1',
      'signed-xdr',
    );
    expect(useTradeStore.getState().error).toBeNull();
    expect(useTradeStore.getState().lastTransactionSubmission).toEqual({
      hash: 'transaction-hash',
      status: 'PENDING',
    });
  });

  it('does not submit when the wallet cancels signing', async () => {
    mockTradeApi.deposit.mockResolvedValue({ unsignedXdr: 'deposit-unsigned-xdr' });
    mockSignTransaction.mockRejectedValue(new Error('User rejected the transaction'));

    await useTradeStore.getState().deposit('trade-1', jest.fn());

    expect(mockTradeApi.submitSignedTransaction).not.toHaveBeenCalled();
    expect(useTradeStore.getState().error).toBe('User rejected the transaction');
  });
});
