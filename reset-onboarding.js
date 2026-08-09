import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.store.updateMany({
    data: { onboardingCompleted: false }
  });
  console.log(`Successfully reset onboarding for ${result.count} store(s).`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
