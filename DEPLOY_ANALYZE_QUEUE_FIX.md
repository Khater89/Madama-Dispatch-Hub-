# MDAMA Analyze + Technician Summary + Quo Message Fix

This build changes only:
- `index.html`
- `supabase/functions/ai-assist/index.ts`

## Deploy

1. Publish the included `index.html` using the same MDAMA web deployment method you already use.

2. Deploy the updated AI Edge Function:

```bash
supabase functions deploy ai-assist --project-ref vuwdhcyiifyarveeqlwz --no-verify-jwt
```

No new SQL migration is required for this build.

## Expected Analyze behavior
- Analyze fills WO fields even if technician preview/search later fails.
- `Technician Job Summary` is technician-facing, complete, and does not merely copy portal questionnaire text.
- SOW remains the source scope from the WO.
- Quo messages use the clean reported issue and direct technician questions.
- Existing independent Live/Yelp queues, 60-mile display limit, Fast Hire, Solo, Worked With, Sticky WO brief, and Coverage remain intact.
