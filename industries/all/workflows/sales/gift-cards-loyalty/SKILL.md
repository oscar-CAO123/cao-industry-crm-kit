---
name: gift-cards-loyalty
description: Gift cards, vouchers and loyalty points in Square for a sales or retail business. Use when setting this up for a client, when an issue or activation is waiting for approval, when a card balance or ledger looks wrong, or when an owner asks why a card or member has not been set up.
---

# Gift cards and loyalty

Issues digital gift cards and enrols members in a loyalty program in Square, activates each card once staff have a paid order for it, and keeps a ledger of gift card sales, loads and redemptions. Crons read, draft and queue; a person approves every card, activation and enrolment.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `activity` reads gift card activity (sales, loads, redemptions, refunds) into a ledger. Reads only.
- `issue` records what a person approved, then queues new digital gift cards, activations of paid cards and loyalty enrolments for approval.
- `balances` confirms the loyalty program is still in Square and reads each enrolled member's points balance. Reads only.

Nothing here sells, takes payment or sends a message. Every card creation, activation and enrolment waits for a person to approve it.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the Square location id and the loyalty program id. Find both in the Square Dashboard.
2. Check the business's gift card and loyalty set-up in Square Dashboard, then confirm the first activity read shows the business's real sales.
3. Confirm the staff who take payment know to set the paid order on a gift card request (see below).

## Judgment steps the person does
- Entering a request. Each sale or enrolment is written into the workflow's store with `kind` and `amount_cents` (or `phone`, or `customer_id`). A gift card request needs whole cents from AUD 1.00 to AUD 5,000.00. A phone must be in E.164 form, for example +61400000000.
- Setting the order. Once the customer has paid at the till for a gift card, set `order_id` on its request. The next `issue` run queues the activation against that order. An activation with no paid order is never queued.
- Approving. Each approval shows the face value, the request key and the enrolment. Check the amount and the member before approving. Rejecting stops that request for good: it is not queued again.
- Choosing a loyalty reward. Staff apply rewards at checkout in Square POS. This workflow does not redeem rewards.
- Handling a card that has been created but not activated, or a member whose enrolment failed after approval. Check Square first, then decide.

## Not covered yet
Payment for a sale (done at the till), reward redemption and points adjustments, card lookup by code, online payment links, physical cards, refund and lost-card rules, and Fresha or Lightspeed. Do these the business's usual way in Square, and note the result on the request so the ledger still reads right.
