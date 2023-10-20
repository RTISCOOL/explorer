import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';

import { TokenBalanceRowWithTokenName } from '@/app/tx/[signature]/page-client';

const openai = new OpenAI({
    apiKey: process.env.STROMA_AZURE_KEY,
    baseURL: process.env.AZURE_BASE_URL,
    defaultHeaders: { 'api-key': process.env.STROMA_AZURE_KEY },
    defaultQuery: { 'api-version': '2023-07-01-preview' },
});

export const runtime = 'edge';

export async function POST(req: Request) {
    const {
        messages,
        signature,
        logMessages,
        balanceChanges,
        tokenBalanceChanges,
    }: {
        messages: { content: string; role: 'system' | 'user' | 'assistant' }[];
        signature: string;
        logMessages: string[];
        balanceChanges: {
            delta: number;
            key: string;
            post: string;
            pre: string;
            pubkey: any;
            tokenName: string;
            extraInfo: string;
        }[];
        tokenBalanceChanges: TokenBalanceRowWithTokenName[];
    } = await req.json();

    const prompt = `
                
    You are the "BLOCKCHAIN EXPLORER ASSISTANT" designed by "DAIN" to be an assistant that is helping people understand what a solana transactions purpose is. 

    you will always refer to yourself as "BLOCKCHAIN EXPLORER ASSISTANT"

    They are currently using the solana explorer, so they know what solana is, they are just needing help understanding what the actual transaction is performing.
    
    The user is not a technical user, just explain what the likely intent of the transaction . 

    The transaction signature is ${signature}


    The transaction solana aaccount changes are: 
    ${
        balanceChanges.length > 0
            ? balanceChanges.map(balanceChange => {
                  return `
                  
                  {${balanceChange.tokenName}} - ${balanceChange.pubkey} changed by ${
                      balanceChange.delta.toString() + ' This account is: ' + balanceChange.extraInfo
                  }\n
                  `;
              })
            : 'No account changes'
    }

    The token account changes are:
    ${
        tokenBalanceChanges.length > 0
            ? tokenBalanceChanges.map(tokenBalanceChange => {
                  return `
                  
                  {${tokenBalanceChange.tokenName}} - ${tokenBalanceChange.mint} owned by account ${
                      tokenBalanceChange.account
                  } changed by ${tokenBalanceChange.delta.toString()} 
                  `;
              })
            : 'No token account changes'
    }

    The transaction log messages are:

    ${
        logMessages
            ? logMessages.map(logMessage => {
                  return `
                  ${logMessage}
                  `;
              })
            : 'No log messages'
    }

    Using the above information, help the user underatand what the transaction is doing without being too technical. Use the account balances changes to indicate what the OUTCOME of the transaction is.

    Remember, signers of the transaction are the people who are executing the transaction, and the instructions are the actual instructions that are being executed.

    Explain who executed the transaction, how their balance changes were effected (including token accounts they own) and what the instructions were that were executed. Think through what hapepned, for example, if a user lost 1 token and gained another, there was probably some type of transfer.

    you will always refer to yourself as "BLOCKCHAIN EXPLORER ASSISTANT" use tons of emojis and be friendly and helpful.


    `;

    const response = await openai.chat.completions.create({
        messages: [
            {
                content: prompt,
                role: 'user',
            },
            ...messages,
        ] as { content: string; role: 'system' | 'user' | 'assistant' }[],

        model: 'gpt-4',

        stream: true,
    });

    const stream = OpenAIStream(response);
    return new StreamingTextResponse(stream);
}
