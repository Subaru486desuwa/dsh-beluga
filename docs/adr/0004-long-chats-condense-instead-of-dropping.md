# Long chats condense their oldest turns instead of dropping them

A model request used to keep the newest whole turns that fit `maxContextBytes` (128 KiB) and drop the rest, showing how many messages it left out. Tool results filled that budget quickly: in one daily chat of seven turns they were two thirds of the bytes, and the model no longer saw the first five turns. The person had no way to act on the notice, and the model lost the conversation without saying so.

Requests now fit the budget in this order, and each step runs only while the request is still over:

1. **Tool results of earlier turns are cleared**, a whole turn at a time from the oldest, freeing the overrun rounded up to a quarter of the budget. The call and its result id stay, with a note that the result can be fetched again. Because the amount moves in quarter steps, the same results stay cleared while the history grows by a quarter of the budget, so the request prefix stays the same and the provider's prompt cache still applies.
2. **Tool results of the current reply are cleared**, oldest first, never the latest step's.
3. **Earlier turns leave the request.** Before that happens, the oldest turns are condensed: the model rewrites them, with the previous condensed text, into one dense account that replaces them in the request. Only when condensing fails do turns leave without one, and the reply still runs.

Condensing normally happens before it is needed. After a reply, if the chat without its earlier tool results is over half the budget, the oldest turns are condensed in the background, keeping the newest quarter of the budget verbatim. A reply waits for condensing only when its request would otherwise lose turns. Neither case shows anything to the person, who still sees and keeps the whole history; exports and search read the stored history, not the condensed text.

Reasoning stays in every turn the request keeps. DeepSeek's thinking mode requires the reasoning of all earlier turns whenever the request declares tools, which Beluga's requests always do, and answers 400 without it. Leaving a whole turn out, or replacing a tool result's content, keeps that rule.

The condensed text belongs to one chat and one place in it: it names the last message it covers, and a branch uses the newest condensed text whose last message is on that branch. Editing an earlier message therefore falls back to an older condensed text, or none, on the new branch. It is stored with the chat, never feeds the Memory Summary, and goes when the chat goes.

`maxContextBytes` now defaults to 512 KiB, since the default DeepSeek routes accept 1,048,576 tokens. When a route discloses its context window, the budget is also held to two bytes per token of what the window leaves after the reply's output tokens, so a small model is not sent more than it accepts.
