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
      key: 'phone',
      title: 'Verify your phone number',
      desc: 'Required so B2B SWAP can text you the moment a company in your trade chain confirms interest.',
      met: !!(acc && acc.verified),
    },
    {
      key: 'email',
      title: 'Add a work email',
      desc: 'Required to receive an email confirmation and written summary of every confirmed trade.',
      met: !!(acc && acc.email),
    },
    {
      key: 'company',
      title: 'Add your company name',
      desc: 'Shown to the other companies in a chain so they know who they are trading with.',
      met: !!(acc && acc.company),
    },
  ];
}

module.exports = { accountToPublic, getNotificationRequirements };
