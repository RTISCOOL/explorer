'use client';

import { Address } from '@components/common/Address';
import { BalanceDelta } from '@components/common/BalanceDelta';
import { ErrorCard } from '@components/common/ErrorCard';
import { InfoTooltip } from '@components/common/InfoTooltip';
import { LoadingCard } from '@components/common/LoadingCard';
import { Signature } from '@components/common/Signature';
import { Slot } from '@components/common/Slot';
import { SolBalance } from '@components/common/SolBalance';
import { TableCardBody } from '@components/common/TableCardBody';
import { SignatureContext } from '@components/instruction/SignatureContext';
import { InstructionsSection } from '@components/transaction/InstructionsSection';
import { ProgramLogSection } from '@components/transaction/ProgramLogSection';
import {
    generateTokenBalanceRows,
    TokenBalanceRow,
    TokenBalancesCard,
} from '@components/transaction/TokenBalancesCard';
import { FetchStatus } from '@providers/cache';
import { useCluster } from '@providers/cluster';
import {
    TransactionStatusInfo,
    useFetchTransactionStatus,
    useTransactionDetails,
    useTransactionStatus,
} from '@providers/transactions';
import { useFetchTransactionDetails } from '@providers/transactions/parsed';
import {
    Connection,
    ParsedTransaction,
    PublicKey,
    SystemInstruction,
    SystemProgram,
    TransactionSignature,
} from '@solana/web3.js';
import { Cluster, ClusterStatus } from '@utils/cluster';
import { displayTimestamp } from '@utils/date';
import { SignatureProps } from '@utils/index';
import { getTransactionInstructionError } from '@utils/program-err';
import { displayAddress, intoTransactionInstruction } from '@utils/tx';
import { useClusterPath } from '@utils/url';
import { useChat } from 'ai/react';
import { BigNumber } from 'bignumber.js';
import bs58 from 'bs58';
import Link from 'next/link';
import React, { Suspense, useEffect, useState } from 'react';
import { RefreshCw, Settings } from 'react-feather';
import useTabVisibility from 'use-tab-visibility';

import { getTokenInfoWithoutOnChainFallback } from '@/app/utils/token-info';

const AUTO_REFRESH_INTERVAL = 2000;
const ZERO_CONFIRMATION_BAILOUT = 5;

enum AutoRefresh {
    Active,
    Inactive,
    BailedOut,
}

type AutoRefreshProps = {
    autoRefresh: AutoRefresh;
};

type Props = Readonly<{
    params: SignatureProps;
}>;

function getTransactionErrorReason(
    info: TransactionStatusInfo,
    tx: ParsedTransaction | undefined
): { errorReason: string; errorLink?: string } {
    if (typeof info.result.err === 'string') {
        return { errorReason: `Runtime Error: "${info.result.err}"` };
    }

    const programError = getTransactionInstructionError(info.result.err);
    if (programError !== undefined) {
        return { errorReason: `Program Error: "Instruction #${programError.index + 1} Failed"` };
    }

    const { InsufficientFundsForRent } = info.result.err as { InsufficientFundsForRent?: { account_index: number } };
    if (InsufficientFundsForRent !== undefined) {
        if (tx) {
            const address = tx.message.accountKeys[InsufficientFundsForRent.account_index].pubkey;
            return { errorLink: `/address/${address}`, errorReason: `Insufficient Funds For Rent: ${address}` };
        }
        return { errorReason: `Insufficient Funds For Rent: Account #${InsufficientFundsForRent.account_index + 1}` };
    }

    return { errorReason: `Unknown Error: "${JSON.stringify(info.result.err)}"` };
}

export default function TransactionDetailsPageClient({ params: { signature: raw } }: Props) {
    let signature: TransactionSignature | undefined;

    try {
        const decoded = bs58.decode(raw);
        if (decoded.length === 64) {
            signature = raw;
        }
    } catch (err) {
        /* empty */
    }

    const status = useTransactionStatus(signature);
    const [zeroConfirmationRetries, setZeroConfirmationRetries] = useState(0);
    const { visible: isTabVisible } = useTabVisibility();

    let autoRefresh = AutoRefresh.Inactive;
    if (!isTabVisible) {
        autoRefresh = AutoRefresh.Inactive;
    } else if (zeroConfirmationRetries >= ZERO_CONFIRMATION_BAILOUT) {
        autoRefresh = AutoRefresh.BailedOut;
    } else if (status?.data?.info && status.data.info.confirmations !== 'max') {
        autoRefresh = AutoRefresh.Active;
    }

    useEffect(() => {
        if (status?.status === FetchStatus.Fetched && status.data?.info && status.data.info.confirmations === 0) {
            setZeroConfirmationRetries(retries => retries + 1);
        }
    }, [status]);

    useEffect(() => {
        if (status?.status === FetchStatus.Fetching && autoRefresh === AutoRefresh.BailedOut) {
            setZeroConfirmationRetries(0);
        }
    }, [status, autoRefresh, setZeroConfirmationRetries]);

    return (
        <div className="container mt-n3">
            <div className="header">
                <div className="header-body">
                    <h6 className="header-pretitle">Details</h6>
                    <h2 className="header-title">Transaction</h2>
                </div>
            </div>
            {signature === undefined ? (
                <ErrorCard text={`Signature "${raw}" is not valid`} />
            ) : (
                <SignatureContext.Provider value={signature}>
                    <StatusCard signature={signature} autoRefresh={autoRefresh} />
                    <Suspense fallback={<LoadingCard message="Loading transaction details" />}>
                        <DetailsSection signature={signature} />
                    </Suspense>
                </SignatureContext.Provider>
            )}
        </div>
    );
}

function StatusCard({ signature, autoRefresh }: SignatureProps & AutoRefreshProps) {
    const fetchStatus = useFetchTransactionStatus();
    const status = useTransactionStatus(signature);
    const details = useTransactionDetails(signature);
    const { cluster, clusterInfo, name: clusterName, status: clusterStatus, url: clusterUrl } = useCluster();
    const inspectPath = useClusterPath({ pathname: `/tx/${signature}/inspect` });

    // Fetch transaction on load
    useEffect(() => {
        if (!status && clusterStatus === ClusterStatus.Connected) {
            fetchStatus(signature);
        }
    }, [signature, clusterStatus]); // eslint-disable-line react-hooks/exhaustive-deps

    // Effect to set and clear interval for auto-refresh
    useEffect(() => {
        if (autoRefresh === AutoRefresh.Active) {
            const intervalHandle: NodeJS.Timeout = setInterval(() => fetchStatus(signature), AUTO_REFRESH_INTERVAL);

            return () => {
                clearInterval(intervalHandle);
            };
        }
    }, [autoRefresh, fetchStatus, signature]);

    if (!status || (status.status === FetchStatus.Fetching && autoRefresh === AutoRefresh.Inactive)) {
        return <LoadingCard />;
    } else if (status.status === FetchStatus.FetchFailed) {
        return <ErrorCard retry={() => fetchStatus(signature)} text="Fetch Failed" />;
    } else if (!status.data?.info) {
        if (clusterInfo && clusterInfo.firstAvailableBlock > 0) {
            return (
                <ErrorCard
                    retry={() => fetchStatus(signature)}
                    text="Not Found"
                    subtext={`Note: Transactions processed before block ${clusterInfo.firstAvailableBlock} are not available at this time`}
                />
            );
        }
        return <ErrorCard retry={() => fetchStatus(signature)} text="Not Found" />;
    }

    const { info } = status.data;

    const transactionWithMeta = details?.data?.transactionWithMeta;
    const fee = transactionWithMeta?.meta?.fee;
    const computeUnitsConsumed = transactionWithMeta?.meta?.computeUnitsConsumed;
    const transaction = transactionWithMeta?.transaction;
    const blockhash = transaction?.message.recentBlockhash;
    const version = transactionWithMeta?.version;
    const isNonce = (() => {
        if (!transaction || transaction.message.instructions.length < 1) {
            return false;
        }

        const ix = intoTransactionInstruction(transaction, transaction.message.instructions[0]);
        return (
            ix &&
            SystemProgram.programId.equals(ix.programId) &&
            SystemInstruction.decodeInstructionType(ix) === 'AdvanceNonceAccount'
        );
    })();

    let statusClass = 'success';
    let statusText = 'Success';
    let errorReason = undefined;
    let errorLink = undefined;

    if (info.result.err) {
        statusClass = 'warning';
        statusText = 'Error';

        const err = getTransactionErrorReason(info, transaction);
        errorReason = err.errorReason;
        if (err.errorLink !== undefined) {
            if (cluster === Cluster.MainnetBeta) {
                errorLink = err.errorLink;
            } else {
                errorLink = `${err.errorLink}?cluster=${clusterName.toLowerCase()}${
                    cluster === Cluster.Custom ? `&customUrl=${clusterUrl}` : ''
                }`;
            }
        }
    }

    return (
        <div className="card">
            <div className="card-header align-items-center">
                <h3 className="card-header-title">Overview</h3>
                <Link className="btn btn-white btn-sm me-2" href={inspectPath}>
                    <Settings className="align-text-top me-2" size={13} />
                    Inspect
                </Link>
                {autoRefresh === AutoRefresh.Active ? (
                    <span className="spinner-grow spinner-grow-sm"></span>
                ) : (
                    <button className="btn btn-white btn-sm" onClick={() => fetchStatus(signature)}>
                        <RefreshCw className="align-text-top me-2" size={13} />
                        Refresh
                    </button>
                )}
            </div>

            <TableCardBody>
                <tr>
                    <td>Signature</td>
                    <td className="text-lg-end">
                        <Signature signature={signature} alignRight />
                    </td>
                </tr>

                <tr>
                    <td>Result</td>
                    <td className="text-lg-end">
                        <h3 className="mb-0">
                            <span className={`badge bg-${statusClass}-soft`}>{statusText}</span>
                        </h3>
                    </td>
                </tr>

                {errorReason !== undefined && (
                    <tr>
                        <td>Error</td>
                        <td className="text-lg-end">
                            <h3 className="mb-0">
                                {errorLink !== undefined ? (
                                    <Link href={errorLink}>
                                        <span className={`badge bg-${statusClass}-soft`}>{errorReason}</span>
                                    </Link>
                                ) : (
                                    <span className={`badge bg-${statusClass}-soft`}>{errorReason}</span>
                                )}
                            </h3>
                        </td>
                    </tr>
                )}

                <tr>
                    <td>Timestamp</td>
                    <td className="text-lg-end">
                        {info.timestamp !== 'unavailable' ? (
                            <span className="font-monospace">{displayTimestamp(info.timestamp * 1000)}</span>
                        ) : (
                            <InfoTooltip bottom right text="Timestamps are only available for confirmed blocks">
                                Unavailable
                            </InfoTooltip>
                        )}
                    </td>
                </tr>

                <tr>
                    <td>Confirmation Status</td>
                    <td className="text-lg-end text-uppercase">{info.confirmationStatus || 'Unknown'}</td>
                </tr>

                <tr>
                    <td>Confirmations</td>
                    <td className="text-lg-end text-uppercase">{info.confirmations}</td>
                </tr>

                <tr>
                    <td>Slot</td>
                    <td className="text-lg-end">
                        <Slot slot={info.slot} link />
                    </td>
                </tr>

                {blockhash && (
                    <tr>
                        <td>
                            {isNonce ? (
                                'Nonce'
                            ) : (
                                <InfoTooltip text="Transactions use a previously confirmed blockhash as a nonce to prevent double spends">
                                    Recent Blockhash
                                </InfoTooltip>
                            )}
                        </td>
                        <td className="text-lg-end">{blockhash}</td>
                    </tr>
                )}

                {fee && (
                    <tr>
                        <td>Fee (SOL)</td>
                        <td className="text-lg-end">
                            <SolBalance lamports={fee} />
                        </td>
                    </tr>
                )}

                {computeUnitsConsumed !== undefined && (
                    <tr>
                        <td>Compute units consumed</td>
                        <td className="text-lg-end">{computeUnitsConsumed.toLocaleString('en-US')}</td>
                    </tr>
                )}

                {version !== undefined && (
                    <tr>
                        <td>Transaction Version</td>
                        <td className="text-lg-end text-uppercase">{version}</td>
                    </tr>
                )}
            </TableCardBody>
        </div>
    );
}

function DetailsSection({ signature }: SignatureProps) {
    const details = useTransactionDetails(signature);
    const fetchDetails = useFetchTransactionDetails();
    const status = useTransactionStatus(signature);
    const transactionWithMeta = details?.data?.transactionWithMeta;
    const transaction = transactionWithMeta?.transaction;
    const message = transaction?.message;
    const { status: clusterStatus } = useCluster();
    const refreshDetails = () => fetchDetails(signature);

    // Fetch details on load
    useEffect(() => {
        if (!details && clusterStatus === ClusterStatus.Connected && status?.status === FetchStatus.Fetched) {
            fetchDetails(signature);
        }
    }, [signature, clusterStatus, status]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!status?.data?.info) {
        return null;
    } else if (!details || details.status === FetchStatus.Fetching) {
        return <LoadingCard />;
    } else if (details.status === FetchStatus.FetchFailed) {
        return <ErrorCard retry={refreshDetails} text="Failed to fetch details" />;
    } else if (!transactionWithMeta || !message) {
        return <ErrorCard text="Details are not available" />;
    }

    return (
        <>
            <AICard signature={signature} />
            <AccountsCard signature={signature} />
            <TokenBalancesCard signature={signature} />
            <InstructionsSection signature={signature} />
            <ProgramLogSection signature={signature} />
        </>
    );
}
export type TokenBalanceRowWithTokenName = TokenBalanceRow & {
    tokenName: string;
    tokenOwner: string | null;
};
function AICard({ signature }: SignatureProps) {
    const { cluster, url } = useCluster();
    const [loading, setLoading] = useState<boolean>(true);
    const [balanceChanges, setBalanceChanges] = useState<
        {
            delta: any;
            key: string;
            post: number;
            pre: number;
            pubkey: PublicKey;
            tokenName: string;
            extraInfo: string;
        }[]
    >([]);

    const [tokenBalanceChanges, setTokenBalanceChanges] = useState<TokenBalanceRowWithTokenName[]>([]);
    const [logMessages, setLogMessages] = useState<string[]>([]);
    const { messages, input, handleInputChange, handleSubmit, append } = useChat({
        api: '/api/ai',
        body: {
            balanceChanges: balanceChanges,

            logMessages: logMessages,
            signature: signature,
            tokenBalanceChanges: tokenBalanceChanges,
        },
    });

    const details = useTransactionDetails(signature);

    React.useEffect(() => {
        const pullTokenInfo = async () => {
            const connection = new Connection(url, 'confirmed');
            const transactionWithMeta = details?.data?.transactionWithMeta;
            if (!transactionWithMeta) {
                return;
            }

            const { meta, transaction } = transactionWithMeta;
            const { message } = transaction;

            if (!meta || !message) {
                console.log('no meta or message');
                return;
            }

            const balanceChanges: {
                delta: any;
                key: string;
                post: number;
                pre: number;
                pubkey: PublicKey;
                tokenName: string;
                extraInfo: string;
            }[] = [];
            for (let i = 0; i < message.accountKeys.length; i++) {
                const account = message.accountKeys[i];
                const pre = meta.preBalances[i];
                const post = meta.postBalances[i];
                const pubkey = account.pubkey;
                const key = account.pubkey.toBase58();
                const delta = new BigNumber(post).minus(new BigNumber(pre)).toNumber();
                const tokenInfo = await getTokenInfoWithoutOnChainFallback(new PublicKey(pubkey), cluster);
                const tokenName = await displayAddress(key, cluster, tokenInfo);

                let extraInfo = '';

                if (i === 0) {
                    extraInfo += ' Fee Payer';
                }
                if (account.signer) {
                    extraInfo += ' Signer';
                }

                if (account.writable) {
                    extraInfo += ' Writable';
                }

                if (account.source === 'lookupTable') {
                    extraInfo += ' Address Table Lookup';
                }

                if (message.instructions.find(ix => ix.programId.equals(pubkey))) {
                    extraInfo += ' Program';
                }

                balanceChanges.push({
                    delta,
                    extraInfo: extraInfo,

                    key,
                    post,
                    pre,
                    pubkey,

                    tokenName: tokenName,
                });
            }

            const preTokenBalances = transactionWithMeta?.meta?.preTokenBalances;
            const postTokenBalances = transactionWithMeta?.meta?.postTokenBalances;
            const accountKeys = transactionWithMeta?.transaction.message.accountKeys;

            if (!preTokenBalances || !postTokenBalances || !accountKeys) {
                return null;
            }

            const rows = generateTokenBalanceRows(preTokenBalances, postTokenBalances, accountKeys);

            // add token name to rows
            const tokenBalanceWithnames: TokenBalanceRowWithTokenName[] = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const tokenInfo = await getTokenInfoWithoutOnChainFallback(new PublicKey(row.mint), cluster);
                const tokenName = await displayAddress(row.mint, cluster, tokenInfo);

                // get the owner of this token account

                const info = await connection.getParsedAccountInfo(row.account);
                const owner = info.value?.owner.toBase58() || null;
                if (!owner) {
                    console.log('no owner');
                    continue;
                }
                const ownerTokenInfo = await getTokenInfoWithoutOnChainFallback(new PublicKey(row.mint), cluster);
                const ownerName = await displayAddress(owner, cluster, ownerTokenInfo);
                tokenBalanceWithnames.push({
                    ...row,
                    tokenName: tokenName,
                    tokenOwner: ownerName,
                });
            }
            setTokenBalanceChanges(tokenBalanceWithnames);
            const logMessages = transactionWithMeta.meta?.logMessages || [];

            setBalanceChanges(balanceChanges);
            setLogMessages(logMessages);
            setLoading(false);
        };
        pullTokenInfo();
    }, [details, cluster, url]);

    const exampleQuestions = [
        'What is happening in this transaction?',
        'What is the purpose of this transaction?',
        'What balance changes are happening in this transaction?',
    ];

    return (
        <>
            <div className="card">
                <div className="card-header">
                    <h3 className="card-header-title"> AI Explanation</h3>
                    <p className="card-header-title">
                        {' '}
                        Powered by <a href="https://twitter.com/buildontal">DAIN</a>
                    </p>
                </div>
                <div className="card-body">
                    <form onSubmit={handleSubmit}>
                        <input
                            placeholder={loading ? 'Loading AI...' : 'Ask a question about this transaction'}
                            type="text"
                            className=" form-control "
                            value={input}
                            onChange={handleInputChange}
                            disabled={loading}
                        />
                        <button disabled={loading} type="submit" className="btn btn-primary mt-3">
                            Submit
                        </button>
                    </form>
                    {messages.length == 0 && (
                        <>
                            <p className="card-text mt-3">
                                <small className="">Example Questions</small>
                            </p>
                            {exampleQuestions.map((question, index) => {
                                return (
                                    <pre
                                        style={{
                                            cursor: 'pointer',
                                        }}
                                        className="card-text mt-2 p-3"
                                        key={index}
                                        onClick={() =>
                                            append({
                                                content: question,

                                                role: 'user',
                                            })
                                        }
                                    >
                                        <small className="">{question}</small>
                                    </pre>
                                );
                            })}
                        </>
                    )}
                </div>
                <div className="table-responsive mb-0">
                    <table className="table table-sm table-nowrap card-table">
                        <tbody className="list">
                            {messages.map((message, index) => {
                                const user_role = message.role;
                                const content = message.content;
                                return (
                                    <tr key={index}>
                                        <td className="flex p-3 ">
                                            <span className="badge bg-info-soft me-1">{user_role}</span>
                                            <pre
                                                style={{
                                                    whiteSpace: 'pre-wrap',
                                                }}
                                                className=" mt-2  "
                                            >
                                                {content}
                                            </pre>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </>
    );
}

function AccountsCard({ signature }: SignatureProps) {
    const details = useTransactionDetails(signature);

    const transactionWithMeta = details?.data?.transactionWithMeta;
    if (!transactionWithMeta) {
        return null;
    }

    const { meta, transaction } = transactionWithMeta;
    const { message } = transaction;

    if (!meta) {
        return <ErrorCard text="Transaction metadata is missing" />;
    }

    const accountRows = message.accountKeys.map((account, index) => {
        const pre = meta.preBalances[index];
        const post = meta.postBalances[index];
        const pubkey = account.pubkey;
        const key = account.pubkey.toBase58();
        const delta = new BigNumber(post).minus(new BigNumber(pre));

        return (
            <tr key={key}>
                <td>{index + 1}</td>
                <td>
                    <Address pubkey={pubkey} link fetchTokenLabelInfo />
                </td>
                <td>
                    <BalanceDelta delta={delta} isSol />
                </td>
                <td>
                    <SolBalance lamports={post} />
                </td>
                <td>
                    {index === 0 && <span className="badge bg-info-soft me-1">Fee Payer</span>}
                    {account.signer && <span className="badge bg-info-soft me-1">Signer</span>}
                    {account.writable && <span className="badge bg-danger-soft me-1">Writable</span>}
                    {message.instructions.find(ix => ix.programId.equals(pubkey)) && (
                        <span className="badge bg-warning-soft me-1">Program</span>
                    )}
                    {account.source === 'lookupTable' && (
                        <span className="badge bg-gray-soft me-1">Address Table Lookup</span>
                    )}
                </td>
            </tr>
        );
    });

    return (
        <div className="card">
            <div className="card-header">
                <h3 className="card-header-title">Account Input(s)</h3>
            </div>
            <div className="table-responsive mb-0">
                <table className="table table-sm table-nowrap card-table">
                    <thead>
                        <tr>
                            <th className="text-muted">#</th>
                            <th className="text-muted">Address</th>
                            <th className="text-muted">Change (SOL)</th>
                            <th className="text-muted">Post Balance (SOL)</th>
                            <th className="text-muted">Details</th>
                        </tr>
                    </thead>
                    <tbody className="list">{accountRows}</tbody>
                </table>
            </div>
        </div>
    );
}
