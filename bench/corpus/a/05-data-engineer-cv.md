---
geometry: margin=0.6in
fontsize: 10pt
pagestyle: empty
---

# Priya Natarajan

**Senior Data Engineer**
Seattle, WA · (206) 555-0148 · priya.natarajan@example.com · linkedin.com/in/priyanatarajan · github.com/pnatarajan

---

## Summary

Data engineer with 7 years of experience building batch and streaming pipelines on AWS and GCP. I design lakehouse platforms that analysts trust, cut warehouse costs without slowing anyone down, and bring software engineering practice (testing, CI/CD, code review) to data work. Most recently led a 4-person team migrating a 300 TB warehouse to an Iceberg lakehouse.

## Experience

**Senior Data Engineer**, Cascade Freight Technologies, Seattle, WA *(Mar 2022 – Present)*

- Led migration of a 300 TB Redshift warehouse to an Apache Iceberg lakehouse on S3 with Trino and Spark; cut monthly compute and storage spend by 41% ($86k/month) with no change to dashboard SLAs.
- Designed a Kafka + Flink streaming pipeline for real-time shipment tracking that ingests 1.2 B events/day at p99 end-to-end latency under 8 seconds.
- Built a data quality framework on Great Expectations and dbt tests covering 420 models; caught 31 upstream schema breaks before they reached production reporting in its first year.
- Introduced dbt, Airflow DAG templates and a CI pipeline (GitHub Actions + `sqlfluff`), reducing average time to ship a new model from 9 days to 2.
- Mentor 3 engineers; run the biweekly data platform design review.

**Data Engineer**, Brightline Health, Portland, OR *(Jun 2019 – Feb 2022)*

- Built HIPAA-compliant ingestion from 14 EHR and claims sources into BigQuery using Airflow and Dataflow, with column-level encryption for PHI.
- Rewrote the nightly claims ETL from stored procedures to PySpark on Dataproc, cutting runtime from 6.5 hours to 50 minutes.
- Created a dimensional model (Kimball star schema) for care-management analytics used by 120+ analysts and clinicians.
- Automated data lineage capture with OpenLineage, which shortened audit preparation from 3 weeks to 4 days.

**Data Analyst → Data Engineer**, Pinecrest Retail Group, Boise, ID *(Jul 2017 – May 2019)*

- Automated weekly sales reporting in Python and SQL, saving the finance team about 15 hours per week.
- Moved point-of-sale extracts from cron scripts to Airflow with retries and alerting; pipeline failures dropped from about 6 per month to fewer than 1.

## Skills

**Languages:** Python, SQL, Scala, Bash
**Processing:** Apache Spark, Flink, Kafka, dbt, Airflow, Dagster
**Storage & warehouses:** Apache Iceberg, Delta Lake, Redshift, BigQuery, Snowflake, PostgreSQL
**Cloud & infrastructure:** AWS (S3, Glue, EMR, MSK, Lambda), GCP (BigQuery, Dataflow, Dataproc), Terraform, Docker, Kubernetes
**Practices:** data modeling, data contracts, data quality testing, CI/CD, cost optimization, privacy engineering (HIPAA, GDPR)

## Education

**M.S., Computer Science**, Oregon State University *(2019)*: Thesis on incremental view maintenance for streaming joins
**B.S., Mathematics**, Boise State University *(2017)*: Minor in Economics

## Certifications

AWS Certified Data Engineer – Associate (2024) · Google Cloud Professional Data Engineer (2021) · dbt Analytics Engineering Certification (2023)
