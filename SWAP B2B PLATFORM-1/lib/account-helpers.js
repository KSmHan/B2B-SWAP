'use strict';

function accountToPublic(acc) {
  if (!acc) return null;
  return {
    id: acc.id,
    phone: acc.phone,
    email: acc.email || null,
    company: acc.company || null,
    verified: !!acc.verified,
  };
}

function getNotificationRequirements(acc) {
  return [
    {
      key: 'email',
      title: 'Verify your email',
      desc: 'Required to receive an email confirmation and written summary of every confirmed trade.',
      met: !!(acc && acc.verified),
    },
    {
      key: 'company',
      title: 'Add your company name',
      desc: 'Shown to the other companies in a chain so they know who they are trading with.',
      met: !!(acc && acc.company),
    },
    {
      key: 'phone',
      title: 'Add a phone number (optional)',
      desc: 'Add a business phone number to also get a text the moment a company in your trade chain confirms interest.',
      met: !!(acc && acc.phone),
    },
  ];
}

module.exports = { accountToPublic, getNotificationRequirements };
