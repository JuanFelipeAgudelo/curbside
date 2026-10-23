# Archive and retention

Two separate things:

- **Archive** (a view): a finished run leaves the main list **10 hours after its printed end**, so a
  3 AM finish is still there when the driver wakes up. It stays readable under ARCHIVE, grouped by day,
  newest first.
- **Delete**: the run, its corrections and its flight tracking are deleted **7 days after its printed
  end** by default. The choice is 2, 7, 14 or 30 days (`RETENTION_CHOICES` in
  `worker/src/retention.ts`). Long enough to check what happened last Tuesday; short enough that
  passengers' names, numbers and hospitals are not kept for a month.

Rules of the sweep (once a day, in the Cloudflare app at 08:00 UTC):

- "Ends" is the run's printed end on the New York clock.
- **A run that cannot be dated is kept**: deleting on a guess is the one mistake with no undo.
- Corrections are deleted **before** the run, so a recycled run number never inherits a dead run's
  corrections.
- A flight another run still meets stays tracked.

In the department: a Dataverse bulk-delete job or a daily flow does the same, and the retention
period is IT's and the department's to approve (`../it-request.md`, item 8). If PDFs are kept (for
example in SharePoint), they go with their run.

A driver can also **hide a run on their own device** (the Cloudflare app: "remove from this phone",
with an UNDO until the run's normal clean-up). That hides it for them only; deleting for everyone is
dispatch's.
