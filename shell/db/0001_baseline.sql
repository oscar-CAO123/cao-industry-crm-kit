-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "crm_AuditLog_Action" AS ENUM ('created', 'updated', 'deleted', 'restored', 'relation_added', 'relation_removed', 'imported', 'cancelled', 'applied', 'undone', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "crm_Opportunity_Status" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING', 'CLOSED');

-- CreateEnum
CREATE TYPE "crm_Product_Type" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "crm_Product_Status" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "crm_Billing_Period" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUALLY', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "crm_AccountProduct_Status" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'PENDING');

-- CreateEnum
CREATE TYPE "crm_Discount_Type" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "crm_Contracts_Status" AS ENUM ('NOTSTARTED', 'INPROGRESS', 'SIGNED');

-- CreateEnum
CREATE TYPE "ExchangeRateSource" AS ENUM ('MANUAL', 'ECB');

-- CreateEnum
CREATE TYPE "crm_Activity_Type" AS ENUM ('call', 'meeting', 'note', 'email');

-- CreateEnum
CREATE TYPE "crm_Activity_Status" AS ENUM ('scheduled', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "DocumentSystemType" AS ENUM ('RECEIPT', 'CONTRACT', 'OFFER', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "taskStatus" AS ENUM ('ACTIVE', 'PENDING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "ActiveStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('cz', 'en', 'de', 'uk');

-- CreateEnum
CREATE TYPE "Invoice_Status" AS ENUM ('DRAFT', 'ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'DISPUTED', 'REFUNDED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "Invoice_Type" AS ENUM ('INVOICE', 'CREDIT_NOTE', 'PROFORMA');

-- CreateTable
CREATE TABLE "crm_Accounts" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "annual_revenue" TEXT,
    "assigned_to" UUID,
    "billing_city" TEXT,
    "billing_country" TEXT,
    "billing_postal_code" TEXT,
    "billing_state" TEXT,
    "billing_street" TEXT,
    "company_id" TEXT,
    "description" TEXT,
    "email" TEXT,
    "employees" TEXT,
    "fax" TEXT,
    "industry" UUID,
    "member_of" TEXT,
    "name" TEXT NOT NULL,
    "office_phone" TEXT,
    "shipping_city" TEXT,
    "shipping_country" TEXT,
    "shipping_postal_code" TEXT,
    "shipping_state" TEXT,
    "shipping_street" TEXT,
    "status" TEXT DEFAULT 'Inactive',
    "type" TEXT DEFAULT 'Customer',
    "vat" TEXT,
    "website" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "crm_Accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Leads" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "firstName" TEXT,
    "lastName" TEXT NOT NULL,
    "company" TEXT,
    "jobTitle" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "description" TEXT,
    "lead_source_id" UUID,
    "lead_status_id" UUID,
    "lead_type_id" UUID,
    "refered_by" TEXT,
    "campaign" TEXT,
    "assigned_to" UUID,
    "accountsIDs" UUID,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "crm_Leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Opportunities" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "account" UUID,
    "assigned_to" UUID,
    "budget" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "campaign" UUID,
    "close_date" TIMESTAMP(3),
    "contact" UUID,
    "created_by" UUID,
    "createdBy" UUID,
    "created_on" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "last_activity_by" UUID,
    "currency" VARCHAR(3),
    "snapshot_rate" DECIMAL(18,8),
    "description" TEXT,
    "expected_revenue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "name" TEXT,
    "next_step" TEXT,
    "sales_stage" UUID,
    "type" UUID,
    "status" "crm_Opportunity_Status" DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "crm_Opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Opportunities_Sales_Stages" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "probability" INTEGER,
    "order" INTEGER,

    CONSTRAINT "crm_Opportunities_Sales_Stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Opportunities_Type" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER,

    CONSTRAINT "crm_Opportunities_Type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Contact_Types" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,

    CONSTRAINT "crm_Contact_Types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Lead_Sources" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,

    CONSTRAINT "crm_Lead_Sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Lead_Statuses" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,

    CONSTRAINT "crm_Lead_Statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Lead_Types" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,

    CONSTRAINT "crm_Lead_Types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Contacts" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "account" UUID,
    "assigned_to" UUID,
    "birthday" TEXT,
    "created_by" UUID,
    "createdBy" UUID,
    "created_on" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "cratedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "last_activity" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "last_activity_by" UUID,
    "description" TEXT,
    "email" TEXT,
    "personal_email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT NOT NULL,
    "office_phone" TEXT,
    "mobile_phone" TEXT,
    "website" TEXT,
    "position" TEXT,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "social_twitter" TEXT,
    "social_facebook" TEXT,
    "social_linkedin" TEXT,
    "social_skype" TEXT,
    "social_instagram" TEXT,
    "social_youtube" TEXT,
    "social_tiktok" TEXT,
    "contact_type_id" UUID,
    "tags" TEXT[],
    "notes" TEXT[],
    "accountsIDs" UUID,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "crm_Contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Contracts" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "startDate" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "renewalReminderDate" TIMESTAMP(3),
    "customerSignedDate" TIMESTAMP(3),
    "companySignedDate" TIMESTAMP(3),
    "description" TEXT,
    "account" UUID,
    "assigned_to" UUID,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "status" "crm_Contracts_Status" NOT NULL DEFAULT 'NOTSTARTED',
    "type" TEXT,
    "currency" VARCHAR(3),
    "snapshot_rate" DECIMAL(18,8),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "crm_Contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Currency" (
    "code" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" VARCHAR(5) NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" UUID NOT NULL,
    "fromCurrency" VARCHAR(3) NOT NULL,
    "toCurrency" VARCHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" "ExchangeRateSource" NOT NULL DEFAULT 'MANUAL',
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_SystemSettings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_SystemSettings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "crm_Activities" (
    "id" UUID NOT NULL,
    "type" "crm_Activity_Type" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER,
    "outcome" TEXT,
    "status" "crm_Activity_Status" NOT NULL DEFAULT 'scheduled',
    "metadata" JSONB,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "crm_Activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_ActivityLinks" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,

    CONSTRAINT "crm_ActivityLinks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Boards" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "favourite" BOOLEAN,
    "favouritePosition" BIGINT,
    "icon" TEXT,
    "position" BIGINT,
    "title" TEXT NOT NULL,
    "user" UUID NOT NULL,
    "visibility" TEXT,
    "sharedWith" UUID[],
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "Boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employees" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "avatar" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "salary" BIGINT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "Employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageUpload" (
    "id" UUID NOT NULL,

    CONSTRAINT "ImageUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Documents" (
    "id" UUID NOT NULL,
    "__v" INTEGER,
    "date_created" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "last_updated" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "document_name" TEXT NOT NULL,
    "created_by_user" UUID,
    "createdBy" UUID,
    "description" TEXT,
    "document_type" UUID,
    "favourite" BOOLEAN,
    "document_file_mimeType" TEXT NOT NULL,
    "document_file_url" TEXT NOT NULL,
    "status" TEXT,
    "visibility" TEXT,
    "tags" JSONB,
    "key" TEXT,
    "size" INTEGER,
    "assigned_user" UUID,
    "connected_documents" TEXT[],
    "content_text" TEXT,
    "summary" TEXT,
    "content_hash" TEXT,
    "thumbnail_url" TEXT,
    "processing_status" "DocumentProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "processing_error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parent_document_id" UUID,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,
    "document_system_type" "DocumentSystemType" DEFAULT 'OTHER',

    CONSTRAINT "Documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Documents_Types" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Documents_Types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sections" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "board" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "position" BIGINT,

    CONSTRAINT "Sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Industry_Type" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "crm_Industry_Type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tasks" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "content" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "dueDateAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "lastEditedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "position" BIGINT NOT NULL,
    "priority" TEXT NOT NULL,
    "section" UUID,
    "tags" JSONB,
    "title" TEXT NOT NULL,
    "likes" BIGINT DEFAULT 0,
    "user" UUID,
    "taskStatus" "taskStatus" DEFAULT 'ACTIVE',

    CONSTRAINT "Tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Accounts_Tasks" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "content" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "dueDateAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "priority" TEXT NOT NULL,
    "tags" JSONB,
    "title" TEXT NOT NULL,
    "likes" BIGINT DEFAULT 0,
    "user" UUID,
    "taskStatus" "taskStatus" DEFAULT 'ACTIVE',
    "account" UUID,

    CONSTRAINT "crm_Accounts_Tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasksComments" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "task" UUID,
    "user" UUID NOT NULL,
    "assigned_crm_account_task" UUID,

    CONSTRAINT "tasksComments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TodoList" (
    "id" UUID NOT NULL,
    "createdAt" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "user" TEXT NOT NULL,

    CONSTRAINT "TodoList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Users" (
    "id" UUID NOT NULL,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "account_name" TEXT,
    "avatar" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "is_account_admin" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT NOT NULL DEFAULT 'member',
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "name" TEXT,
    "password" TEXT,
    "username" TEXT,
    "userStatus" "ActiveStatus" NOT NULL DEFAULT 'PENDING',
    "userLanguage" "Language" NOT NULL DEFAULT 'en',
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),

    CONSTRAINT "Users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_AuditLog" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "crm_AuditLog_Action" NOT NULL,
    "changes" JSONB,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Report_Config" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_Report_Config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentsToOpportunities" (
    "document_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,

    CONSTRAINT "DocumentsToOpportunities_pkey" PRIMARY KEY ("document_id","opportunity_id")
);

-- CreateTable
CREATE TABLE "DocumentsToContacts" (
    "document_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,

    CONSTRAINT "DocumentsToContacts_pkey" PRIMARY KEY ("document_id","contact_id")
);

-- CreateTable
CREATE TABLE "DocumentsToTasks" (
    "document_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,

    CONSTRAINT "DocumentsToTasks_pkey" PRIMARY KEY ("document_id","task_id")
);

-- CreateTable
CREATE TABLE "DocumentsToCrmAccountsTasks" (
    "document_id" UUID NOT NULL,
    "crm_accounts_task_id" UUID NOT NULL,

    CONSTRAINT "DocumentsToCrmAccountsTasks_pkey" PRIMARY KEY ("document_id","crm_accounts_task_id")
);

-- CreateTable
CREATE TABLE "DocumentsToLeads" (
    "document_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,

    CONSTRAINT "DocumentsToLeads_pkey" PRIMARY KEY ("document_id","lead_id")
);

-- CreateTable
CREATE TABLE "DocumentsToAccounts" (
    "document_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,

    CONSTRAINT "DocumentsToAccounts_pkey" PRIMARY KEY ("document_id","account_id")
);

-- CreateTable
CREATE TABLE "AccountWatchers" (
    "account_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "AccountWatchers_pkey" PRIMARY KEY ("account_id","user_id")
);

-- CreateTable
CREATE TABLE "BoardWatchers" (
    "board_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "BoardWatchers_pkey" PRIMARY KEY ("board_id","user_id")
);

-- CreateTable
CREATE TABLE "ContactsToOpportunities" (
    "contact_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,

    CONSTRAINT "ContactsToOpportunities_pkey" PRIMARY KEY ("contact_id","opportunity_id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_ProductCategories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "crm_ProductCategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_Products" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT,
    "type" "crm_Product_Type" NOT NULL,
    "status" "crm_Product_Status" NOT NULL DEFAULT 'DRAFT',
    "unit_price" DECIMAL(18,2) NOT NULL,
    "unit_cost" DECIMAL(18,2),
    "currency" VARCHAR(3) NOT NULL,
    "tax_rate" DECIMAL(5,2),
    "unit" TEXT,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "billing_period" "crm_Billing_Period",
    "categoryId" UUID,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "crm_Products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_AccountProducts" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "custom_price" DECIMAL(18,2),
    "currency" VARCHAR(3) NOT NULL,
    "snapshot_rate" DECIMAL(18,8),
    "status" "crm_AccountProduct_Status" NOT NULL DEFAULT 'ACTIVE',
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "renewal_date" TIMESTAMP(3),
    "notes" TEXT,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "crm_AccountProducts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_OpportunityLineItems" (
    "id" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "discount_type" "crm_Discount_Type" NOT NULL DEFAULT 'PERCENTAGE',
    "discount_value" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "crm_OpportunityLineItems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_ContractLineItems" (
    "id" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "discount_type" "crm_Discount_Type" NOT NULL DEFAULT 'PERCENTAGE',
    "discount_value" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "__v" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "crm_ContractLineItems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoices" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "type" "Invoice_Type" NOT NULL DEFAULT 'INVOICE',
    "status" "Invoice_Status" NOT NULL DEFAULT 'DRAFT',
    "number" TEXT,
    "numberOverridden" BOOLEAN NOT NULL DEFAULT false,
    "seriesId" UUID,
    "accountId" UUID NOT NULL,
    "billingSnapshot" JSONB,
    "issueDate" TIMESTAMP(3),
    "taxableSupplyDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "currency" VARCHAR(3) NOT NULL,
    "baseCurrency" VARCHAR(3),
    "fxRateToBase" DECIMAL(18,8),
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "vatTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "iban" TEXT,
    "swift" TEXT,
    "variableSymbol" TEXT,
    "publicNotes" TEXT,
    "internalNotes" TEXT,
    "originalInvoiceId" UUID,
    "pdfStorageKey" TEXT,
    "pdfGeneratedAt" TIMESTAMP(3),
    "search_vector" tsvector,

    CONSTRAINT "Invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice_LineItems" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "productId" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxRateId" UUID,
    "taxRateSnapshot" DECIMAL(5,2),
    "lineSubtotal" DECIMAL(14,2) NOT NULL,
    "lineVat" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "Invoice_LineItems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice_Payments" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_Payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice_Attachments" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedBy" UUID NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isPrimaryPdf" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Invoice_Attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice_Activity" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice_TaxRates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_TaxRates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice_Series" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefixTemplate" TEXT NOT NULL,
    "resetPolicy" TEXT NOT NULL DEFAULT 'YEARLY',
    "currentYear" INTEGER,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_Series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice_Currencies" (
    "code" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_Currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Invoice_Settings" (
    "id" UUID NOT NULL,
    "baseCurrency" VARCHAR(3) NOT NULL,
    "defaultSeriesId" UUID,
    "defaultTaxRateId" UUID,
    "defaultDueDays" INTEGER NOT NULL DEFAULT 14,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "iban" TEXT,
    "swift" TEXT,
    "footerText" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell_TemplateApplications" (
    "id" UUID NOT NULL,
    "industry" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "appliedBy" UUID NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneBy" UUID,
    "undoneAt" TIMESTAMP(3),
    "changes" JSONB NOT NULL,

    CONSTRAINT "shell_TemplateApplications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell_Pages" (
    "id" UUID NOT NULL,
    "department" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "spec" JSONB NOT NULL,
    "applicationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shell_Pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell_Workflows" (
    "id" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "applicationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shell_Workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell_Records" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "stage" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "assigned_to" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" UUID,

    CONSTRAINT "shell_Records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell_State" (
    "ns" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shell_State_pkey" PRIMARY KEY ("ns","key")
);

-- CreateIndex
CREATE INDEX "crm_Accounts_assigned_to_idx" ON "crm_Accounts"("assigned_to");

-- CreateIndex
CREATE INDEX "crm_Accounts_industry_idx" ON "crm_Accounts"("industry");

-- CreateIndex
CREATE INDEX "crm_Accounts_createdBy_idx" ON "crm_Accounts"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Accounts_updatedBy_idx" ON "crm_Accounts"("updatedBy");

-- CreateIndex
CREATE INDEX "crm_Accounts_status_idx" ON "crm_Accounts"("status");

-- CreateIndex
CREATE INDEX "crm_Accounts_type_idx" ON "crm_Accounts"("type");

-- CreateIndex
CREATE INDEX "crm_Accounts_createdAt_idx" ON "crm_Accounts"("createdAt");

-- CreateIndex
CREATE INDEX "crm_Accounts_deletedAt_idx" ON "crm_Accounts"("deletedAt");

-- CreateIndex
CREATE INDEX "crm_Leads_assigned_to_idx" ON "crm_Leads"("assigned_to");

-- CreateIndex
CREATE INDEX "crm_Leads_accountsIDs_idx" ON "crm_Leads"("accountsIDs");

-- CreateIndex
CREATE INDEX "crm_Leads_createdBy_idx" ON "crm_Leads"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Leads_updatedBy_idx" ON "crm_Leads"("updatedBy");

-- CreateIndex
CREATE INDEX "crm_Leads_lead_source_id_idx" ON "crm_Leads"("lead_source_id");

-- CreateIndex
CREATE INDEX "crm_Leads_lead_status_id_idx" ON "crm_Leads"("lead_status_id");

-- CreateIndex
CREATE INDEX "crm_Leads_lead_type_id_idx" ON "crm_Leads"("lead_type_id");

-- CreateIndex
CREATE INDEX "crm_Leads_createdAt_idx" ON "crm_Leads"("createdAt");

-- CreateIndex
CREATE INDEX "crm_Leads_deletedAt_idx" ON "crm_Leads"("deletedAt");

-- CreateIndex
CREATE INDEX "crm_Opportunities_account_idx" ON "crm_Opportunities"("account");

-- CreateIndex
CREATE INDEX "crm_Opportunities_assigned_to_idx" ON "crm_Opportunities"("assigned_to");

-- CreateIndex
CREATE INDEX "crm_Opportunities_campaign_idx" ON "crm_Opportunities"("campaign");

-- CreateIndex
CREATE INDEX "crm_Opportunities_contact_idx" ON "crm_Opportunities"("contact");

-- CreateIndex
CREATE INDEX "crm_Opportunities_created_by_idx" ON "crm_Opportunities"("created_by");

-- CreateIndex
CREATE INDEX "crm_Opportunities_sales_stage_idx" ON "crm_Opportunities"("sales_stage");

-- CreateIndex
CREATE INDEX "crm_Opportunities_type_idx" ON "crm_Opportunities"("type");

-- CreateIndex
CREATE INDEX "crm_Opportunities_status_idx" ON "crm_Opportunities"("status");

-- CreateIndex
CREATE INDEX "crm_Opportunities_createdAt_idx" ON "crm_Opportunities"("createdAt");

-- CreateIndex
CREATE INDEX "crm_Opportunities_close_date_idx" ON "crm_Opportunities"("close_date");

-- CreateIndex
CREATE INDEX "crm_Opportunities_status_sales_stage_idx" ON "crm_Opportunities"("status", "sales_stage");

-- CreateIndex
CREATE INDEX "crm_Opportunities_deletedAt_idx" ON "crm_Opportunities"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "crm_Contact_Types_name_key" ON "crm_Contact_Types"("name");

-- CreateIndex
CREATE INDEX "crm_Contact_Types_name_idx" ON "crm_Contact_Types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "crm_Lead_Sources_name_key" ON "crm_Lead_Sources"("name");

-- CreateIndex
CREATE INDEX "crm_Lead_Sources_name_idx" ON "crm_Lead_Sources"("name");

-- CreateIndex
CREATE UNIQUE INDEX "crm_Lead_Statuses_name_key" ON "crm_Lead_Statuses"("name");

-- CreateIndex
CREATE INDEX "crm_Lead_Statuses_name_idx" ON "crm_Lead_Statuses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "crm_Lead_Types_name_key" ON "crm_Lead_Types"("name");

-- CreateIndex
CREATE INDEX "crm_Lead_Types_name_idx" ON "crm_Lead_Types"("name");

-- CreateIndex
CREATE INDEX "crm_Contacts_assigned_to_idx" ON "crm_Contacts"("assigned_to");

-- CreateIndex
CREATE INDEX "crm_Contacts_created_by_idx" ON "crm_Contacts"("created_by");

-- CreateIndex
CREATE INDEX "crm_Contacts_accountsIDs_idx" ON "crm_Contacts"("accountsIDs");

-- CreateIndex
CREATE INDEX "crm_Contacts_createdBy_idx" ON "crm_Contacts"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Contacts_updatedBy_idx" ON "crm_Contacts"("updatedBy");

-- CreateIndex
CREATE INDEX "crm_Contacts_status_idx" ON "crm_Contacts"("status");

-- CreateIndex
CREATE INDEX "crm_Contacts_contact_type_id_idx" ON "crm_Contacts"("contact_type_id");

-- CreateIndex
CREATE INDEX "crm_Contacts_cratedAt_idx" ON "crm_Contacts"("cratedAt");

-- CreateIndex
CREATE INDEX "crm_Contacts_last_activity_idx" ON "crm_Contacts"("last_activity");

-- CreateIndex
CREATE INDEX "crm_Contacts_deletedAt_idx" ON "crm_Contacts"("deletedAt");

-- CreateIndex
CREATE INDEX "crm_Contracts_account_idx" ON "crm_Contracts"("account");

-- CreateIndex
CREATE INDEX "crm_Contracts_assigned_to_idx" ON "crm_Contracts"("assigned_to");

-- CreateIndex
CREATE INDEX "crm_Contracts_createdBy_idx" ON "crm_Contracts"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Contracts_updatedBy_idx" ON "crm_Contracts"("updatedBy");

-- CreateIndex
CREATE INDEX "crm_Contracts_status_idx" ON "crm_Contracts"("status");

-- CreateIndex
CREATE INDEX "crm_Contracts_startDate_idx" ON "crm_Contracts"("startDate");

-- CreateIndex
CREATE INDEX "crm_Contracts_endDate_idx" ON "crm_Contracts"("endDate");

-- CreateIndex
CREATE INDEX "crm_Contracts_createdAt_idx" ON "crm_Contracts"("createdAt");

-- CreateIndex
CREATE INDEX "crm_Contracts_startDate_endDate_idx" ON "crm_Contracts"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "crm_Contracts_deletedAt_idx" ON "crm_Contracts"("deletedAt");

-- CreateIndex
CREATE INDEX "ExchangeRate_fromCurrency_idx" ON "ExchangeRate"("fromCurrency");

-- CreateIndex
CREATE INDEX "ExchangeRate_toCurrency_idx" ON "ExchangeRate"("toCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_fromCurrency_toCurrency_key" ON "ExchangeRate"("fromCurrency", "toCurrency");

-- CreateIndex
CREATE INDEX "crm_Activities_date_idx" ON "crm_Activities"("date");

-- CreateIndex
CREATE INDEX "crm_Activities_type_idx" ON "crm_Activities"("type");

-- CreateIndex
CREATE INDEX "crm_Activities_status_idx" ON "crm_Activities"("status");

-- CreateIndex
CREATE INDEX "crm_Activities_createdBy_idx" ON "crm_Activities"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Activities_createdAt_idx" ON "crm_Activities"("createdAt");

-- CreateIndex
CREATE INDEX "crm_Activities_deletedAt_idx" ON "crm_Activities"("deletedAt");

-- CreateIndex
CREATE INDEX "crm_ActivityLinks_activityId_idx" ON "crm_ActivityLinks"("activityId");

-- CreateIndex
CREATE INDEX "crm_ActivityLinks_entityType_entityId_activityId_idx" ON "crm_ActivityLinks"("entityType", "entityId", "activityId");

-- CreateIndex
CREATE INDEX "Boards_user_idx" ON "Boards"("user");

-- CreateIndex
CREATE INDEX "Boards_createdBy_idx" ON "Boards"("createdBy");

-- CreateIndex
CREATE INDEX "Boards_updatedBy_idx" ON "Boards"("updatedBy");

-- CreateIndex
CREATE INDEX "Boards_favourite_idx" ON "Boards"("favourite");

-- CreateIndex
CREATE INDEX "Boards_visibility_idx" ON "Boards"("visibility");

-- CreateIndex
CREATE INDEX "Boards_createdAt_idx" ON "Boards"("createdAt");

-- CreateIndex
CREATE INDEX "Boards_user_favourite_idx" ON "Boards"("user", "favourite");

-- CreateIndex
CREATE INDEX "Boards_deletedAt_idx" ON "Boards"("deletedAt");

-- CreateIndex
CREATE INDEX "Documents_created_by_user_idx" ON "Documents"("created_by_user");

-- CreateIndex
CREATE INDEX "Documents_assigned_user_idx" ON "Documents"("assigned_user");

-- CreateIndex
CREATE INDEX "Documents_document_type_idx" ON "Documents"("document_type");

-- CreateIndex
CREATE INDEX "Documents_createdBy_idx" ON "Documents"("createdBy");

-- CreateIndex
CREATE INDEX "Documents_status_idx" ON "Documents"("status");

-- CreateIndex
CREATE INDEX "Documents_visibility_idx" ON "Documents"("visibility");

-- CreateIndex
CREATE INDEX "Documents_favourite_idx" ON "Documents"("favourite");

-- CreateIndex
CREATE INDEX "Documents_createdAt_idx" ON "Documents"("createdAt");

-- CreateIndex
CREATE INDEX "Documents_document_system_type_idx" ON "Documents"("document_system_type");

-- CreateIndex
CREATE INDEX "Documents_content_hash_idx" ON "Documents"("content_hash");

-- CreateIndex
CREATE INDEX "Documents_parent_document_id_idx" ON "Documents"("parent_document_id");

-- CreateIndex
CREATE INDEX "Documents_processing_status_idx" ON "Documents"("processing_status");

-- CreateIndex
CREATE INDEX "Documents_deletedAt_idx" ON "Documents"("deletedAt");

-- CreateIndex
CREATE INDEX "Sections_board_idx" ON "Sections"("board");

-- CreateIndex
CREATE INDEX "Tasks_user_idx" ON "Tasks"("user");

-- CreateIndex
CREATE INDEX "Tasks_section_idx" ON "Tasks"("section");

-- CreateIndex
CREATE INDEX "Tasks_createdBy_idx" ON "Tasks"("createdBy");

-- CreateIndex
CREATE INDEX "Tasks_updatedBy_idx" ON "Tasks"("updatedBy");

-- CreateIndex
CREATE INDEX "Tasks_priority_idx" ON "Tasks"("priority");

-- CreateIndex
CREATE INDEX "Tasks_taskStatus_idx" ON "Tasks"("taskStatus");

-- CreateIndex
CREATE INDEX "Tasks_dueDateAt_idx" ON "Tasks"("dueDateAt");

-- CreateIndex
CREATE INDEX "Tasks_createdAt_idx" ON "Tasks"("createdAt");

-- CreateIndex
CREATE INDEX "Tasks_user_taskStatus_idx" ON "Tasks"("user", "taskStatus");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_user_idx" ON "crm_Accounts_Tasks"("user");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_account_idx" ON "crm_Accounts_Tasks"("account");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_createdBy_idx" ON "crm_Accounts_Tasks"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_updatedBy_idx" ON "crm_Accounts_Tasks"("updatedBy");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_priority_idx" ON "crm_Accounts_Tasks"("priority");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_taskStatus_idx" ON "crm_Accounts_Tasks"("taskStatus");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_dueDateAt_idx" ON "crm_Accounts_Tasks"("dueDateAt");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_createdAt_idx" ON "crm_Accounts_Tasks"("createdAt");

-- CreateIndex
CREATE INDEX "crm_Accounts_Tasks_account_taskStatus_idx" ON "crm_Accounts_Tasks"("account", "taskStatus");

-- CreateIndex
CREATE INDEX "tasksComments_task_idx" ON "tasksComments"("task");

-- CreateIndex
CREATE INDEX "tasksComments_user_idx" ON "tasksComments"("user");

-- CreateIndex
CREATE INDEX "tasksComments_assigned_crm_account_task_idx" ON "tasksComments"("assigned_crm_account_task");

-- CreateIndex
CREATE UNIQUE INDEX "Users_email_key" ON "Users"("email");

-- CreateIndex
CREATE INDEX "Users_email_idx" ON "Users"("email");

-- CreateIndex
CREATE INDEX "Users_userStatus_idx" ON "Users"("userStatus");

-- CreateIndex
CREATE INDEX "Users_userLanguage_idx" ON "Users"("userLanguage");

-- CreateIndex
CREATE INDEX "Users_is_admin_idx" ON "Users"("is_admin");

-- CreateIndex
CREATE INDEX "Users_is_account_admin_idx" ON "Users"("is_account_admin");

-- CreateIndex
CREATE INDEX "Users_created_on_idx" ON "Users"("created_on");

-- CreateIndex
CREATE INDEX "Users_lastLoginAt_idx" ON "Users"("lastLoginAt");

-- CreateIndex
CREATE INDEX "crm_AuditLog_entityType_entityId_createdAt_idx" ON "crm_AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "crm_AuditLog_userId_idx" ON "crm_AuditLog"("userId");

-- CreateIndex
CREATE INDEX "crm_AuditLog_createdAt_idx" ON "crm_AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "crm_AuditLog_entityType_createdAt_idx" ON "crm_AuditLog"("entityType", "createdAt");

-- CreateIndex
CREATE INDEX "crm_Report_Config_createdBy_idx" ON "crm_Report_Config"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Report_Config_category_idx" ON "crm_Report_Config"("category");

-- CreateIndex
CREATE INDEX "crm_Report_Config_isShared_idx" ON "crm_Report_Config"("isShared");

-- CreateIndex
CREATE INDEX "DocumentsToOpportunities_document_id_idx" ON "DocumentsToOpportunities"("document_id");

-- CreateIndex
CREATE INDEX "DocumentsToOpportunities_opportunity_id_idx" ON "DocumentsToOpportunities"("opportunity_id");

-- CreateIndex
CREATE INDEX "DocumentsToContacts_document_id_idx" ON "DocumentsToContacts"("document_id");

-- CreateIndex
CREATE INDEX "DocumentsToContacts_contact_id_idx" ON "DocumentsToContacts"("contact_id");

-- CreateIndex
CREATE INDEX "DocumentsToTasks_document_id_idx" ON "DocumentsToTasks"("document_id");

-- CreateIndex
CREATE INDEX "DocumentsToTasks_task_id_idx" ON "DocumentsToTasks"("task_id");

-- CreateIndex
CREATE INDEX "DocumentsToCrmAccountsTasks_document_id_idx" ON "DocumentsToCrmAccountsTasks"("document_id");

-- CreateIndex
CREATE INDEX "DocumentsToCrmAccountsTasks_crm_accounts_task_id_idx" ON "DocumentsToCrmAccountsTasks"("crm_accounts_task_id");

-- CreateIndex
CREATE INDEX "DocumentsToLeads_document_id_idx" ON "DocumentsToLeads"("document_id");

-- CreateIndex
CREATE INDEX "DocumentsToLeads_lead_id_idx" ON "DocumentsToLeads"("lead_id");

-- CreateIndex
CREATE INDEX "DocumentsToAccounts_document_id_idx" ON "DocumentsToAccounts"("document_id");

-- CreateIndex
CREATE INDEX "DocumentsToAccounts_account_id_idx" ON "DocumentsToAccounts"("account_id");

-- CreateIndex
CREATE INDEX "AccountWatchers_account_id_idx" ON "AccountWatchers"("account_id");

-- CreateIndex
CREATE INDEX "AccountWatchers_user_id_idx" ON "AccountWatchers"("user_id");

-- CreateIndex
CREATE INDEX "BoardWatchers_board_id_idx" ON "BoardWatchers"("board_id");

-- CreateIndex
CREATE INDEX "BoardWatchers_user_id_idx" ON "BoardWatchers"("user_id");

-- CreateIndex
CREATE INDEX "ContactsToOpportunities_contact_id_idx" ON "ContactsToOpportunities"("contact_id");

-- CreateIndex
CREATE INDEX "ContactsToOpportunities_opportunity_id_idx" ON "ContactsToOpportunities"("opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "crm_ProductCategories_isActive_idx" ON "crm_ProductCategories"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "crm_Products_sku_key" ON "crm_Products"("sku");

-- CreateIndex
CREATE INDEX "crm_Products_status_idx" ON "crm_Products"("status");

-- CreateIndex
CREATE INDEX "crm_Products_type_idx" ON "crm_Products"("type");

-- CreateIndex
CREATE INDEX "crm_Products_categoryId_idx" ON "crm_Products"("categoryId");

-- CreateIndex
CREATE INDEX "crm_Products_createdBy_idx" ON "crm_Products"("createdBy");

-- CreateIndex
CREATE INDEX "crm_Products_deletedAt_idx" ON "crm_Products"("deletedAt");

-- CreateIndex
CREATE INDEX "crm_AccountProducts_accountId_idx" ON "crm_AccountProducts"("accountId");

-- CreateIndex
CREATE INDEX "crm_AccountProducts_productId_idx" ON "crm_AccountProducts"("productId");

-- CreateIndex
CREATE INDEX "crm_AccountProducts_status_idx" ON "crm_AccountProducts"("status");

-- CreateIndex
CREATE INDEX "crm_AccountProducts_accountId_productId_idx" ON "crm_AccountProducts"("accountId", "productId");

-- CreateIndex
CREATE INDEX "crm_OpportunityLineItems_opportunityId_idx" ON "crm_OpportunityLineItems"("opportunityId");

-- CreateIndex
CREATE INDEX "crm_OpportunityLineItems_productId_idx" ON "crm_OpportunityLineItems"("productId");

-- CreateIndex
CREATE INDEX "crm_ContractLineItems_contractId_idx" ON "crm_ContractLineItems"("contractId");

-- CreateIndex
CREATE INDEX "crm_ContractLineItems_productId_idx" ON "crm_ContractLineItems"("productId");

-- CreateIndex
CREATE INDEX "Invoices_accountId_idx" ON "Invoices"("accountId");

-- CreateIndex
CREATE INDEX "Invoices_status_idx" ON "Invoices"("status");

-- CreateIndex
CREATE INDEX "Invoices_issueDate_idx" ON "Invoices"("issueDate");

-- CreateIndex
CREATE INDEX "Invoices_dueDate_idx" ON "Invoices"("dueDate");

-- CreateIndex
CREATE INDEX "Invoices_createdBy_idx" ON "Invoices"("createdBy");

-- CreateIndex
CREATE INDEX "Invoices_originalInvoiceId_idx" ON "Invoices"("originalInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoices_seriesId_number_key" ON "Invoices"("seriesId", "number");

-- CreateIndex
CREATE INDEX "Invoice_LineItems_invoiceId_idx" ON "Invoice_LineItems"("invoiceId");

-- CreateIndex
CREATE INDEX "Invoice_LineItems_productId_idx" ON "Invoice_LineItems"("productId");

-- CreateIndex
CREATE INDEX "Invoice_LineItems_taxRateId_idx" ON "Invoice_LineItems"("taxRateId");

-- CreateIndex
CREATE INDEX "Invoice_Payments_invoiceId_idx" ON "Invoice_Payments"("invoiceId");

-- CreateIndex
CREATE INDEX "Invoice_Attachments_invoiceId_idx" ON "Invoice_Attachments"("invoiceId");

-- CreateIndex
CREATE INDEX "Invoice_Activity_invoiceId_idx" ON "Invoice_Activity"("invoiceId");

-- CreateIndex
CREATE INDEX "shell_TemplateApplications_industry_status_idx" ON "shell_TemplateApplications"("industry", "status");

-- CreateIndex
CREATE INDEX "shell_Pages_applicationId_idx" ON "shell_Pages"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "shell_Pages_department_slug_key" ON "shell_Pages"("department", "slug");

-- CreateIndex
CREATE INDEX "shell_Workflows_department_idx" ON "shell_Workflows"("department");

-- CreateIndex
CREATE INDEX "shell_Records_kind_stage_idx" ON "shell_Records"("kind", "stage");

-- CreateIndex
CREATE INDEX "shell_Records_deletedAt_idx" ON "shell_Records"("deletedAt");

-- AddForeignKey
ALTER TABLE "crm_Accounts" ADD CONSTRAINT "crm_Accounts_industry_fkey" FOREIGN KEY ("industry") REFERENCES "crm_Industry_Type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Accounts" ADD CONSTRAINT "crm_Accounts_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Leads" ADD CONSTRAINT "crm_Leads_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "crm_Lead_Sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Leads" ADD CONSTRAINT "crm_Leads_lead_status_id_fkey" FOREIGN KEY ("lead_status_id") REFERENCES "crm_Lead_Statuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Leads" ADD CONSTRAINT "crm_Leads_lead_type_id_fkey" FOREIGN KEY ("lead_type_id") REFERENCES "crm_Lead_Types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Leads" ADD CONSTRAINT "crm_Leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Leads" ADD CONSTRAINT "crm_Leads_accountsIDs_fkey" FOREIGN KEY ("accountsIDs") REFERENCES "crm_Accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Opportunities" ADD CONSTRAINT "crm_Opportunities_type_fkey" FOREIGN KEY ("type") REFERENCES "crm_Opportunities_Type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Opportunities" ADD CONSTRAINT "crm_Opportunities_sales_stage_fkey" FOREIGN KEY ("sales_stage") REFERENCES "crm_Opportunities_Sales_Stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Opportunities" ADD CONSTRAINT "crm_Opportunities_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Opportunities" ADD CONSTRAINT "crm_Opportunities_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Opportunities" ADD CONSTRAINT "crm_Opportunities_account_fkey" FOREIGN KEY ("account") REFERENCES "crm_Accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Opportunities" ADD CONSTRAINT "crm_Opportunities_currency_fkey" FOREIGN KEY ("currency") REFERENCES "Currency"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Contacts" ADD CONSTRAINT "crm_Contacts_contact_type_id_fkey" FOREIGN KEY ("contact_type_id") REFERENCES "crm_Contact_Types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Contacts" ADD CONSTRAINT "crm_Contacts_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Contacts" ADD CONSTRAINT "crm_Contacts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Contacts" ADD CONSTRAINT "crm_Contacts_accountsIDs_fkey" FOREIGN KEY ("accountsIDs") REFERENCES "crm_Accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Contracts" ADD CONSTRAINT "crm_Contracts_account_fkey" FOREIGN KEY ("account") REFERENCES "crm_Accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Contracts" ADD CONSTRAINT "crm_Contracts_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Contracts" ADD CONSTRAINT "crm_Contracts_currency_fkey" FOREIGN KEY ("currency") REFERENCES "Currency"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_fromCurrency_fkey" FOREIGN KEY ("fromCurrency") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_toCurrency_fkey" FOREIGN KEY ("toCurrency") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Activities" ADD CONSTRAINT "crm_Activities_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Activities" ADD CONSTRAINT "crm_Activities_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_ActivityLinks" ADD CONSTRAINT "crm_ActivityLinks_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "crm_Activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Boards" ADD CONSTRAINT "Boards_user_fkey" FOREIGN KEY ("user") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documents" ADD CONSTRAINT "Documents_created_by_user_fkey" FOREIGN KEY ("created_by_user") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documents" ADD CONSTRAINT "Documents_assigned_user_fkey" FOREIGN KEY ("assigned_user") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documents" ADD CONSTRAINT "Documents_document_type_fkey" FOREIGN KEY ("document_type") REFERENCES "Documents_Types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documents" ADD CONSTRAINT "Documents_parent_document_id_fkey" FOREIGN KEY ("parent_document_id") REFERENCES "Documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sections" ADD CONSTRAINT "Sections_board_fkey" FOREIGN KEY ("board") REFERENCES "Boards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tasks" ADD CONSTRAINT "Tasks_user_fkey" FOREIGN KEY ("user") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tasks" ADD CONSTRAINT "Tasks_section_fkey" FOREIGN KEY ("section") REFERENCES "Sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Accounts_Tasks" ADD CONSTRAINT "crm_Accounts_Tasks_user_fkey" FOREIGN KEY ("user") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Accounts_Tasks" ADD CONSTRAINT "crm_Accounts_Tasks_account_fkey" FOREIGN KEY ("account") REFERENCES "crm_Accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasksComments" ADD CONSTRAINT "tasksComments_assigned_crm_account_task_fkey" FOREIGN KEY ("assigned_crm_account_task") REFERENCES "crm_Accounts_Tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasksComments" ADD CONSTRAINT "tasksComments_task_fkey" FOREIGN KEY ("task") REFERENCES "Tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasksComments" ADD CONSTRAINT "tasksComments_user_fkey" FOREIGN KEY ("user") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_AuditLog" ADD CONSTRAINT "crm_AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Report_Config" ADD CONSTRAINT "crm_Report_Config_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToOpportunities" ADD CONSTRAINT "DocumentsToOpportunities_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToOpportunities" ADD CONSTRAINT "DocumentsToOpportunities_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "crm_Opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToContacts" ADD CONSTRAINT "DocumentsToContacts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToContacts" ADD CONSTRAINT "DocumentsToContacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "crm_Contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToTasks" ADD CONSTRAINT "DocumentsToTasks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToTasks" ADD CONSTRAINT "DocumentsToTasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToCrmAccountsTasks" ADD CONSTRAINT "DocumentsToCrmAccountsTasks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToCrmAccountsTasks" ADD CONSTRAINT "DocumentsToCrmAccountsTasks_crm_accounts_task_id_fkey" FOREIGN KEY ("crm_accounts_task_id") REFERENCES "crm_Accounts_Tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToLeads" ADD CONSTRAINT "DocumentsToLeads_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToLeads" ADD CONSTRAINT "DocumentsToLeads_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_Leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToAccounts" ADD CONSTRAINT "DocumentsToAccounts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentsToAccounts" ADD CONSTRAINT "DocumentsToAccounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "crm_Accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountWatchers" ADD CONSTRAINT "AccountWatchers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "crm_Accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountWatchers" ADD CONSTRAINT "AccountWatchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardWatchers" ADD CONSTRAINT "BoardWatchers_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "Boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardWatchers" ADD CONSTRAINT "BoardWatchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactsToOpportunities" ADD CONSTRAINT "ContactsToOpportunities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "crm_Contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactsToOpportunities" ADD CONSTRAINT "ContactsToOpportunities_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "crm_Opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Products" ADD CONSTRAINT "crm_Products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "crm_ProductCategories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Products" ADD CONSTRAINT "crm_Products_currency_fkey" FOREIGN KEY ("currency") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_Products" ADD CONSTRAINT "crm_Products_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_AccountProducts" ADD CONSTRAINT "crm_AccountProducts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "crm_Accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_AccountProducts" ADD CONSTRAINT "crm_AccountProducts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "crm_Products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_AccountProducts" ADD CONSTRAINT "crm_AccountProducts_currency_fkey" FOREIGN KEY ("currency") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_OpportunityLineItems" ADD CONSTRAINT "crm_OpportunityLineItems_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "crm_Opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_OpportunityLineItems" ADD CONSTRAINT "crm_OpportunityLineItems_productId_fkey" FOREIGN KEY ("productId") REFERENCES "crm_Products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_ContractLineItems" ADD CONSTRAINT "crm_ContractLineItems_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "crm_Contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_ContractLineItems" ADD CONSTRAINT "crm_ContractLineItems_productId_fkey" FOREIGN KEY ("productId") REFERENCES "crm_Products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Invoice_Series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "crm_Accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_currency_fkey" FOREIGN KEY ("currency") REFERENCES "Invoice_Currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "Invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_LineItems" ADD CONSTRAINT "Invoice_LineItems_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_LineItems" ADD CONSTRAINT "Invoice_LineItems_productId_fkey" FOREIGN KEY ("productId") REFERENCES "crm_Products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_LineItems" ADD CONSTRAINT "Invoice_LineItems_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "Invoice_TaxRates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Payments" ADD CONSTRAINT "Invoice_Payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Payments" ADD CONSTRAINT "Invoice_Payments_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Attachments" ADD CONSTRAINT "Invoice_Attachments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Attachments" ADD CONSTRAINT "Invoice_Attachments_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Activity" ADD CONSTRAINT "Invoice_Activity_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Activity" ADD CONSTRAINT "Invoice_Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Settings" ADD CONSTRAINT "Invoice_Settings_defaultSeriesId_fkey" FOREIGN KEY ("defaultSeriesId") REFERENCES "Invoice_Series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice_Settings" ADD CONSTRAINT "Invoice_Settings_defaultTaxRateId_fkey" FOREIGN KEY ("defaultTaxRateId") REFERENCES "Invoice_TaxRates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

