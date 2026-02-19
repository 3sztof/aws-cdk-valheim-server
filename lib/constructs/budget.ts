import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { ValheimConfig } from '../config';

export interface BudgetAlertProps {
  config: ValheimConfig;
}

export class BudgetAlert extends Construct {
  constructor(scope: Construct, id: string, props: BudgetAlertProps) {
    super(scope, id);

    const { config } = props;

    if (!config.budget.enabled) {
      return;
    }

    const subscribers: budgets.CfnBudget.SubscriberProperty[] = config.budget.alertEmails.map(email => ({
      subscriptionType: 'EMAIL',
      address: email,
    }));

    const notifications: budgets.CfnBudget.NotificationWithSubscribersProperty[] =
      config.budget.thresholds.map(threshold => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      }));

    if (config.budget.forecastAlert) {
      notifications.push({
        notification: {
          notificationType: 'FORECASTED',
          comparisonOperator: 'GREATER_THAN',
          threshold: config.budget.forecastThreshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      });
    }

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${config.tags.Project}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: config.budget.monthlyLimit,
          unit: 'USD',
        },
        costFilters: {
          TagKeyValue: [`user:Project$${config.tags.Project}`],
        },
      },
      notificationsWithSubscribers: notifications,
    });
  }
}
