import type { AnyPadroneBuilder, CommandTypesBase } from 'padrone';
import { zodAsyncStream } from 'padrone/zod';
import * as z from 'zod/v4';
import { sleep } from './sleep.ts';

const ANSWERS: [RegExp, string[]][] = [
  [
    /pineapple/i,
    ['Ah, pineapple.', 'Half of my kitchen loves it, the other half has left the building.', 'Try the Hawaiian and decide for yourself.'],
  ],
  [
    /dough|crust/i,
    [
      'Flour, water, salt and a little yeast.',
      'Then 48 hours of patience in the fridge.',
      'That is the whole secret. Mostly the patience.',
    ],
  ],
  [
    /cheese|formaggi/i,
    [
      'Fresh mozzarella for most pizzas.',
      'For the Quattro Formaggi: gorgonzola, parmesan and fontina too.',
      'Add --cheese extra if you are brave.',
    ],
  ],
  [/spic|chili|hot/i, ['Order with -p for a little heat.', '-ppp if you want to feel it.', '-ppppp and you sign a waiver.']],
  [
    /padrone|cli|type/i,
    [
      'This whole pizzeria is a Padrone program.',
      'Every flag you type is validated by a Zod schema.',
      'Even my answers are streamed from an async generator.',
    ],
  ],
];

const FALLBACK = ['Good question.', 'I would answer it, but the oven needs me.', 'Ask me about dough, cheese, pineapple or spice.'];

/**
 * A custom extension: a reusable bundle added with `.extend(chef)`. It contributes the `chef` command group;
 * extensions can also add interceptors, configuration and arguments.
 */
export function chef<T extends CommandTypesBase>(builder: T): T {
  return (builder as unknown as AnyPadroneBuilder).command('chef', (c) =>
    c
      .configure({ title: 'Talk to the chef', group: 'Fun' })
      .command('ask', (c) =>
        c
          .configure({ title: 'Ask the chef a question', examples: ['pizza chef ask how do you make the dough?'] })
          .arguments(z.object({ question: z.array(z.string()).min(1).describe('Your question') }), {
            positional: ['...question'],
            interactive: ['question'],
          })
          // An async generator: every yielded line is printed as soon as it's ready
          .action(async function* (args, ctx) {
            const question = args.question.join(' ');
            const answer = ANSWERS.find(([pattern]) => pattern.test(question))?.[1] ?? FALLBACK;
            for (const line of answer) {
              await sleep(500, ctx.signal);
              yield `👨‍🍳 ${line}`;
            }
          }),
      )
      .command('chat', (c) =>
        c
          .configure({ title: 'Chat with the chef (Ctrl+D to leave)', examples: ['echo "hello chef" | pizza chef chat'] })
          .arguments(z.object({ messages: zodAsyncStream(z.string()) }), { stdin: 'messages' })
          // `messages` streams lines from stdin: piped input, or typed lines until Ctrl+D
          .action(async function* (args, ctx) {
            yield '👨‍🍳 Ciao! What can I do for you?';
            for await (const message of args.messages) {
              if (!message.trim()) continue;
              await sleep(300, ctx.signal);
              yield `👨‍🍳 "${message}"? ${FALLBACK[Math.floor(Math.random() * FALLBACK.length)]}`;
            }
            yield '👨‍🍳 Arrivederci!';
          }),
      ),
  ) as unknown as T;
}
