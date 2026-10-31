#!/bin/sh
set -eu

# Fila padrão (não FIFO): a consistência não depende da ordem nem da entrega única do
# SQS. Quem garante é o banco (idempotência e lock por carteira).
awslocal sqs create-queue --queue-name wagering-events
