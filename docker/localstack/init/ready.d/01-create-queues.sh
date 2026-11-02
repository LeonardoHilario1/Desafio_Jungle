#!/bin/sh
set -eu

# fila dos eventos que a aplicação publica (outbox). é padrão, não FIFO: quem garante a
# consistência é o banco, e o consumidor deduplica pelo eventId
awslocal sqs create-queue --queue-name wagering-events

# entrada de transações: FIFO com dead-letter. o consumidor manda pra DLQ sozinho depois
# de CONSUMER_MAX_ATTEMPTS (5); o maxReceiveCount 10 da RedrivePolicy é só rede de
# segurança, pro caso de o processo morrer bem na hora de mover
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"ContentBasedDeduplication\": \"false\",
  \"VisibilityTimeout\": \"30\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"
}"
