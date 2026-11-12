# Glossary: Manufacturing

Trade terms the manufacturing workflows use, in plain words.

**Allergen**: A food ingredient that can cause an allergic reaction, and so must be declared on the label. The draft lists the allergens each ingredient carries, and any may-contain statement is checked against the supplier's specification. Used by `food-labels`.

**Assembly**: A product made by putting components together, recorded as a build that can be scheduled and then completed. Used by `x-workorders`, `x-shopfloor`.

**BOM** (bill of materials): The list of components and the quantity of each that go into one product. A work order raised without one has no lines. Used by `x-bom`, `x-workorders`.

**Corrective action**: The fix and root cause written down after a fault, complaint or failed check, so the same problem is less likely to return. Used by `lottrace`.

**Dispatch**: Sending finished goods out to a customer. The lot trace follows stock from receipt through production to dispatch. Used by `lottrace`.

**Fault finding**: Working out what caused a machine breakdown before anything is repaired. The workflow drafts a note from the customer's earlier jobs and the parts on hand, and the technician decides the cause. Used by `faultfind`.

**Food Standards Code**: The Australia New Zealand Food Standards Code, which sets what a food label must show. Each draft is checked against it before any label is used. Used by `food-labels`.

**GTIN** (Global Trade Item Number): The barcode number that identifies a product. It has 8, 12, 13 or 14 digits, the last of which is a check digit, and GS1 issues the numbers. Used by `barcode-compliance`.

**Ingredient declaration**: The ingredient list printed on a food label, with the ingredient that weighs most listed first. Used by `food-labels`.

**Lockout**: Isolating a machine from its power source and locking it off, so it cannot start while someone works on it. Used by `x-maintenance`.

**Lot**: A batch or serial number that groups products made or received together, so each one can be traced from receipt to dispatch. Used by `lottrace`.

**Minimum stock**: The lowest quantity of a product the business wants on hand. When stock falls under it, the reorder step raises a parked order. Used by `purchase`, `x-shopfloor`, `x-workorders`.

**Nutrition panel**: The table on a food label showing energy and nutrients per serve and per 100 g (or 100 mL). The draft works it out from the recipe's ingredients and their grams. Used by `food-labels`.

**Parked order**: An order or bill saved in the stock system but not yet released. A parked order moves no stock and reaches no supplier until someone releases it. Used by `purchase`, `x-workorders`, `x-bom`.

**PO** (purchase order): A written order to a supplier for goods, with quantities and prices. The reorder step raises a parked purchase order for each product under its minimum. Used by `purchase`, `supplierquotes`.

**Price tolerance**: How far a supplier bill's price may differ from the item's purchase price before the line is flagged. The default in this kit is 2 percent. Used by `supplierdocs`.

**Quarantine**: Holding stock in a separate warehouse so it cannot be sold or used until it is released. The quarantine step queues a stock transfer for each lot put on hold. Used by `lottrace`.

**Rate card**: The business's own list of prices for each code, from which a quote is priced. A request with a code that is not on the card is held until someone adds it. Used by `takeoff`.

**Receipt**: Goods counted in against an order. Only a receipted order becomes a draft supplier bill. Used by `purchase`, `lottrace`.

**SDS** (safety data sheet): The document that sets out a chemical's hazards, storage, handling and first aid. Each SDS carries a review date, and the workflow flags any that are near or past it. Used by `sds`.

**Second look**: A check result that means a person must look again before a decision is made. It is recorded with a note saying what needs the second look. Used by `photocheck`.

**Signal word**: The word "Warning" or "Danger" on a chemical label that shows how serious the hazard is. Used by `sds`.

**SKU** (stock keeping unit): The code the business uses to track one product. In this kit, a supplier bill line is matched to a SKU by its item code. Used by `supplierdocs`.

**Stock on hand**: The quantity of a product the stock system shows as held in the warehouse right now. Used by `purchase`, `lottrace`, `x-bom`, `x-workorders`.

**Stock transfer**: Moving stock from one warehouse to another, recorded in the stock system. A quarantine moves a lot to the quarantine warehouse this way. Used by `lottrace`.

**Supplier bill**: A supplier's invoice held in the accounting system. A draft bill waits for a person to check it against the supplier's document and approve it, which makes it payable. Used by `purchase`, `supplierdocs`.

**Takeoff**: Measuring the quantities of materials and work from drawings so a job can be priced. In this kit the estimator measures and enters the quantities, and the workflow prices them. Used by `takeoff`.

**Test return**: Running a repaired machine to confirm it works before the job is closed. The technician records the result. Used by `faultfind`.

**Work order**: A job record that tells the floor to make a set quantity of a product, or to carry out a maintenance task. A parked work order moves no stock. Used by `x-workorders`, `x-maintenance`.
