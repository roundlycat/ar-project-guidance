# Semantic Brain: pgvector Database Schema

The AR Guidance system uses a heavily customized PostgreSQL cluster running on the **Inferno Pi**. The core of this system is the `pgvector` extension, which allows for extremely fast similarity searches on mathematical representations (embeddings) of electronic components.

## 1. Database Architecture: `sensor_ecology`

The backend runs entirely on PostgreSQL. Rather than relying on rigid exact-string matching (which fails when camera lighting changes or components are viewed from weird angles), the database operates on "Semantic Proximity."

### A. The `pgvector` Extension
`pgvector` must be enabled at the database level:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```
This grants access to the `vector(DIMENSIONS)` data type, allowing arrays of floating-point numbers (our embeddings) to be stored natively and compared using standard SQL syntax.

---

## 2. Table Design: `parts_catalogue`

The `parts_catalogue` is the definitive "Ground Truth" table. All bounding boxes captured by the AR Fast Track are eventually funneled here for absolute identification.

```sql
CREATE TABLE parts_catalogue (
    id SERIAL PRIMARY KEY,
    part_name VARCHAR(255) NOT NULL,
    part_family VARCHAR(100),         -- e.g., 'Resistor', 'Microcontroller'
    visual_description TEXT NOT NULL, -- The Gemini-generated visual context
    metadata JSONB,                   -- Extra data (e.g. pinouts, data sheet URL)
    embedding VECTOR(768),            -- The exact mathematical representation
    added_at TIMESTAMP DEFAULT NOW()
);
```

### Key Column Breakdown
*   **`visual_description`:** When a component is ingested, Gemini Vision generates a highly descriptive paragraph describing its physical characteristics (color, shape, text on the chip, pin count).
*   **`embedding VECTOR(768)`:** This `visual_description` is run through an embedding model (like `sentence-transformers` or text-embedding-api) to turn it into a 768-dimensional array. This represents the semantic "meaning" of the component.
*   **`metadata JSONB`:** Rather than rigidly creating columns for every type of spec, a JSONB column allows flexible storage (voltage thresholds, URLs to PDFs, warning flags).

---

## 3. The Match Execution (Cosine Similarity)

When a user triggers a **"Spacebar Snap"**, the incoming camera crop is sent to Gemini, converted to an embedding on the fly (`query_embedding`), and then we ask the database to find the closest match.

In `pgvector`, the `<=>` operator computes the Cosine Distance between two vectors. The lower the distance, the closer the match.

**The Semantic Retrieval Query:**
```sql
SELECT 
    part_name, 
    visual_description,
    1 - (embedding <=> '[0.014, -0.091, ...]') AS confidence_score
FROM 
    parts_catalogue
WHERE 
    1 - (embedding <=> '[0.014, -0.091, ...]') > 0.82 -- Minimum Confidence Threshold
ORDER BY 
    embedding <=> '[0.014, -0.091, ...]' ASC
LIMIT 1;
```

*Note: By doing `1 - (embedding <=> query)`, we translate mathematical distance (where 0 is identical) into a Human-Readable Confidence Score (where 1.0 is a 100% identical match).*

---

## 4. Short-Term Memory vs Long-Term Archiving

To prevent the `parts_catalogue` from becoming clogged with noisy, blurry, or incorrect scans from the workbench, we strictly separate Ephemeral queries from Archival inserts.

1. **The Retrieval Stream:** The `registry_intake.py` endpoint only executes `SELECT` statements with the cosine operator.
2. **The Ingestion Pipeline:** Hard-saving a new component into the `parts_catalogue` is a deliberate backend action. When a completely foreign object is snapped, the system will not auto-ingest it. The user must instruct the backend to permanently append the new embedding, preventing data drift.

### HNSW Indexing for Scale
For future-proofing, as the catalogue scales past thousands of components, an HNSW (Hierarchical Navigable Small World) index is placed over the embedding column to ensure millisecond queries over Local Wi-Fi:

```sql
CREATE INDEX ON parts_catalogue 
USING hnsw (embedding vector_cosine_ops);
```
