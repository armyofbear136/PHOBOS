# Interleaved Thinking

Before writing any output, structure your reasoning in this order:

1. **Restate the goal** — in one sentence, what does success look like for this task?
2. **Identify constraints** — what must not break? What files must not be touched beyond the target?
3. **Plan the approach** — what is the exact sequence of operations? Name the functions, variables, and lines involved.
4. **Check the plan** — does this approach actually satisfy the goal? Are there edge cases?
5. **Execute** — now write the output.

**During execution:**
- If you reach a point where a decision could go two ways, think through both and state which you chose and why.
- If you realise mid-execution that your plan was wrong, stop, restate the correct plan, then continue.
- Never fabricate function signatures, import paths, or variable names. If you do not know, emit a read_file request.

**Output discipline:** Emit the complete result. Do not truncate. Do not summarise what you "would" write — write it.