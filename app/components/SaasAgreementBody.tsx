// B118 Layer 2 Commit 3 (attorney final) — SaaS Subscription Agreement body.
//
// Attorney final swapped 2026-07-10 keyed to SAAS_VERSION '2026-07-10-v1'.
// Source: 260710_Shield_My_Lot_SaaS_Agreement.docx (Jose's project knowledge).
//
// Structure: preamble (parties + Background + NOW THEREFORE) → 9 numbered
// sections (Services=1 ... Miscellaneous=9) → signature block → Exhibit A
// Service Level Plan. Cross-references in the text ("Section 1.2 Access",
// "Section 4 Confidentiality", "Sections 2-9 survive") resolve because the
// rendered section headings include the numbers.
//
// Fidelity discipline: byte-identical to the attorney's Word file. Preserve
// ALL-CAPS disclaimer/liability blocks verbatim. Address "9711 Mason Road,
// STE 125 #270 · Richmond, TX 77407" (contract of record). Both shieldmylot.com
// links (privacy + terms) verbatim. Any transcription drift on served copy
// = gate fail. Version bump = new SAAS_VERSION in app/lib/legal-versions.ts.

export default function SaasAgreementBody() {
  const h1: React.CSSProperties  = { color:'#C9A227', fontSize:'20px', fontWeight:'bold', margin:'32px 0 12px' }
  const h2: React.CSSProperties  = { color:'#C9A227', fontSize:'15px', fontWeight:'bold', margin:'22px 0 8px' }
  const h3: React.CSSProperties  = { color:'#C9A227', fontSize:'13px', fontWeight:'bold', margin:'16px 0 6px' }
  const p:  React.CSSProperties  = { color:'#cbd5e1', fontSize:'13px', lineHeight:'1.7', margin:'0 0 10px' }
  const li: React.CSSProperties  = { color:'#cbd5e1', fontSize:'13px', lineHeight:'1.7', margin:'0 0 6px' }
  const ul: React.CSSProperties  = { paddingLeft:'22px', margin:'0 0 10px' }
  const tableWrap: React.CSSProperties = { overflowX:'auto', margin:'0 0 12px' }
  const table: React.CSSProperties = { width:'100%', borderCollapse:'collapse', fontSize:'12px', color:'#cbd5e1' }
  const th: React.CSSProperties  = { textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #3a4055', color:'#C9A227' }
  const td: React.CSSProperties  = { padding:'6px 8px', borderBottom:'1px solid #2a2f3d', verticalAlign:'top' }
  const link: React.CSSProperties = { color:'#C9A227' }

  return (
    <div>
      <h1 style={h1}>SOFTWARE AS A SERVICE AGREEMENT</h1>

      <p style={p}>
        This ShieldMyLot Software as a Service Agreement, together with its exhibits, Order Forms, and Pricing Schedule (&quot;<b>Agreement</b>&quot;), effective as of the last date of signature (&quot;<b>Effective Date</b>&quot;), is by and between Alvarado Legacy Consulting, LLC, a Texas limited liability company, with registered office located at 9711 Mason Road, STE 125 #270, Richmond, TX &nbsp;77407 (&quot;<b>Company</b>&quot;), and the entity listed in the signature block below (&quot;<b>Customer</b>&quot;).  Company and Customer may be referred to herein collectively as the &quot;Parties&quot; or individually as a &quot;<b>Party</b>.&quot;
      </p>
      <p style={p}>
        Background. Company&rsquo;s &quot;ShieldMyLot&quot; software-as-a-service is a documentation and workflow platform for towing companies and property managers (together with the accompanying documentation, the &quot;<b>Service</b>&quot;).  Company provides access to the Service to its customers and Customer desires to access the Service from Company subject to the terms and conditions of this Agreement.
      </p>
      <p style={p}>
        NOW, THEREFORE, in consideration of the mutual covenants, terms, and conditions set forth herein, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:
      </p>

      <h1 style={h1}>1. Services</h1>

      <h2 style={h2}>1.1 Provisioning</h2>
      <p style={p}>
        Company shall provide to Customer the means for Customer to create a unique username and password combination used to access the Services in the quantities set forth at the Order Form (the &quot;<b>Credentials</b>&quot;).  Customer understands and agrees that Customer is solely responsible for the security of the Credentials, and for all activity resulting from any use thereof and its use of the Service, including any and all Fees resulting from the foregoing.
      </p>
      <p style={p}>
        &quot;<b>Order Form</b>&quot; means the electronic order completed at sign-up/check-out and includes the then-current Pricing Schedule.
      </p>

      <h2 style={h2}>1.2 Access</h2>
      <p style={p}>
        Subject to this Agreement, Company hereby grants Customer the non-exclusive, personal, non-transferable (except via Permitted Assignment) right for Authorized Users to Use the Service.  Except for the limited rights expressly granted above, all other rights are reserved by Company, and nothing herein grants (by implication, waiver, estoppel, or otherwise) to Customer or any third party any intellectual property rights or other right, title, or interest in or to Company IP.
      </p>
      <p style={p}>
        &quot;<b>Authorized User</b>&quot; means Customer&rsquo;s employees, consultants, contractors, and agents (a) who are authorized by Customer to access and use the Services under the rights granted to Customer pursuant to this Agreement and (b) for whom access to the Services has been purchased hereunder, and (c) with respect to whom Customer makes reasonable efforts to make aware of, and caused to comply with, this Agreement and applicable law.
      </p>
      <p style={p}>
        &quot;<b>Use</b>&quot; means Customer&rsquo;s internal business use in connection with the Services and is not a Prohibited Use.  &quot;<b>Prohibited Use</b>&quot; means any use of the Service beyond the scope of that specifically permitted by this Agreement, including but not limited to (a) copy, modify, or create derivative works, in whole or in part; (b) rent, lease, lend, sell, license, sublicense, assign, distribute, publish, transfer, or otherwise make available; (c) reverse engineer, disassemble, decompile, decode, adapt, or otherwise attempt to derive or gain access to software components, in whole or in part; (d) remove any proprietary marks or notices; or (e) use in any manner or for any purpose that infringes, misappropriates, or otherwise violates any intellectual property right or other right of any person, or that tends to devalue the intellectual property rights of Company, or that violates any applicable law.
      </p>
      <p style={p}>
        &quot;<b>Company IP</b>&quot; means all Company Confidential Information and intellectual or industrial property owned by Company (including for example, copyrights in the Service software and documentation, Aggregated Statistics, Feedback, and the trademark &quot;ShieldMyLot&quot;).
      </p>

      <h2 style={h2}>1.3 Service Modifications</h2>
      <p style={p}>
        Company reserves the right to modify, update, or discontinue any feature or functionality of the Service at any time.  For material reductions in functionality, Company will provide thirty (30) days&rsquo; prior written notice.  If any such modification materially and adversely affects Customer&rsquo;s core use case, Customer may terminate without penalty upon Notice within thirty days.
      </p>

      <h2 style={h2}>1.4 Service Levels &amp; Support</h2>
      <p style={p}>
        Subject to the terms and conditions of this Agreement, Company shall use commercially reasonable efforts to make the Services and Support available in accordance with its then-current Service Level Plan during the Term (as exemplified at Exhibit A).
      </p>

      <h3 style={h3}>Suspension</h3>
      <p style={p}>
        Notwithstanding anything to the contrary in this Agreement, Company may temporarily suspend Customer&rsquo;s and any Authorized User&rsquo;s access to any portion or all of the Services in the event of (a) a Service Threat, or (b) a Supplier Disruption, (c) a Non-Payment Period (any of the foregoing, a &quot;<b>Service Suspension</b>&quot;).  A &quot;<b>Service Threat</b>&quot; exists upon Company&rsquo; reasonable determination that (a) there is a threat or attack on the Service; or (b) Customer&rsquo;s use (including any access via Credentials) of the Service disrupts or poses a security risk or service level risk to the Service or to any other customer or vendor of Company; or (c) Customer (or any use via Credentials) accesses the Service for fraudulent or illegal activities; or (d) subject to applicable law, Customer has ceased to continue its business in the ordinary course, made an assignment for the benefit of creditors or similar disposition of its assets, or become the subject of any bankruptcy, reorganization, liquidation, dissolution, or similar proceeding; or (e) the Service (or use thereof) is prohibited by applicable law, or alleged to infringe third-party rights.  Company shall use commercially reasonable efforts to (a) provide Notice of any Service Suspension to Customer and to provide updates regarding resumption of access to the Services following any Service Suspension, and (b) resume providing access to the Services as soon as commercially reasonable (in Company&rsquo; own reasonable business judgement) after the event giving rise to the Service Suspension is cured.  &quot;<b>Supplier Disruption</b>&quot; means any vendor of Company has suspended or terminated Company&rsquo;s access to or use of any third-party services or products used by Company to enable Customer to access the Service.
      </p>
      <p style={p}>
        &quot;<b>Notice</b>&quot; means a notification or other communication hereunder that is:  (a) in writing, and (b) addressed to a Party at their address set forth in the preamble of this Agreement (or to such other address (or email address) as such Party may later designate pursuant to Notice), and (c) timely delivered via nationally recognized overnight courier (with all fees pre-paid) providing proof of delivery, or via email if so designated, and (d) effective upon receipt of such Party.
      </p>

      <h1 style={h1}>2. Data Use</h1>

      <h2 style={h2}>2.1 Website Terms of Service &amp; Privacy Policy</h2>
      <p style={p}>
        Customer acknowledges and agrees that all use of the Service is subject to the ShieldMyLot Privacy Policy (located at <a href="https://shieldmylot.com/privacy" style={link}>https://shieldmylot.com/privacy</a>, and updated from time to time), and to the ShieldMyLot Terms of Services (located at <a href="https://shieldmylot.com/terms" style={link}>https://shieldmylot.com/terms</a>, and updated from time to time).
      </p>

      <h2 style={h2}>2.2 Processing</h2>
      <p style={p}>
        Customer hereby authorizes Company to use Customer Data in connection with Company&rsquo;s provision of the Service.
      </p>
      <p style={p}>
        &quot;<b>Customer Data</b>&quot; means, other than Aggregated Statistics, information, data, and other content, in any form or medium, that is submitted, posted, or otherwise transmitted by or on behalf of Customer or an Authorized User through the Service.  Customer Data includes, for example, resident and Authorized User names, unit numbers, vehicle license plate numbers, and messages between Authorized Users during collaboration.
      </p>

      <h2 style={h2}>2.3 Third Parties</h2>
      <p style={p}>
        Company may share reports and other outputs of the Service with third parties in order to complete Service objectives.
      </p>

      <h2 style={h2}>2.4 Service Monitoring</h2>
      <p style={p}>
        Notwithstanding anything to the contrary in this Agreement, Company may monitor Customer&rsquo;s use of the Services and collect and compile Aggregated Statistics.  Customer acknowledges that Company may compile Aggregated Statistics based on Customer Data input into the Services.  Customer agrees that Company may (a) make Aggregated Statistics publicly available in compliance with applicable law, and (b) use Aggregated Statistics to the extent and in the manner permitted under applicable law; provided that such Aggregated Statistics do not identify Customer or Customer&rsquo;s Confidential Information.
      </p>
      <p style={p}>
        &quot;<b>Aggregated Statistics</b>&quot; means data and information related to Customer&rsquo;s use of the Services that is used by Company in an aggregate and anonymized manner, including to compile statistical and performance information related to the provision and operation of the Services.
      </p>
      <p style={p}>
        &quot;<b>Confidential Information</b>&quot; means information disclosed or made available to a Party (&quot;<b>Recipient</b>&quot;) about the other Party&rsquo;s business affairs, products, confidential intellectual property, trade secrets, third-party confidential information, and other sensitive or proprietary information, whether orally or in written, electronic or other form, or whether or not marked, designated, or otherwise identified as &quot;confidential.&quot;  Confidential Information does not include information Recipient can demonstrate was not subject to any duty of non-disclosure, and at the time of disclosure was: (a) in the public domain; (b) known to Recipient; (c) rightfully obtained by Recipient on a non-confidential basis from a third party; or (d) independently developed by Recipient.
      </p>

      <h2 style={h2}>2.5 Feedback</h2>
      <p style={p}>
        Customer hereby assigns to Company on behalf itself and the Sources, all right, title, and interest in Feedback.  Company is free to use, without any attribution or compensation to any party, any ideas, know-how, concepts, techniques, or other intellectual property rights contained in the Feedback, for any purpose whatsoever.
      </p>
      <p style={p}>
        &quot;<b>Feedback</b>&quot; means communications from Customer or its representatives, including for example, employees, contractors, and Authorized Users (the &quot;<b>Sources</b>&quot;) to Company suggesting or recommending changes to the Company IP, including without limitation, new features or functionality relating thereto, or any comments, questions, suggestions, or the like.
      </p>

      <h1 style={h1}>3. Fees and Payment</h1>

      <h2 style={h2}>3.1 Fees</h2>
      <p style={p}>
        Customer shall pay Company the fees as set forth in the Order Form (&quot;<b>Fees</b>&quot;) without offset or deduction.  Customer shall make all payments hereunder in US dollars on or before the due date set forth in the Order Form.  If Customer fails to make any payment when due, without limiting Company&rsquo;s other rights and remedies:  (a) Company may charge interest on the past due amount at the rate of 1.5% per month calculated daily and compounded monthly or, if lower, the highest rate permitted under applicable law; (b) Customer shall reimburse Company for all reasonable costs incurred by Company in collecting any late payments or interest, including attorneys&rsquo; fees, court costs, and collection agency fees; and (c) if such failure continues for five (5) days or more, Company may suspend Customer&rsquo;s and its Authorized Users&rsquo; access to any portion or all of the Services until such amounts are paid in full (a &quot;<b>Non-Payment Period</b>&quot;).  In the event of under-reporting, actual usage charges plus interest will apply.
      </p>

      <h2 style={h2}>3.2 Payments</h2>
      <p style={p}>
        All fees are due and payable monthly, in advance.  All payments are nonrefundable; except that a full refund is available if the Service is canceled by Notice within the first 14 days of the 1st Term.  Customer shall reimburse Company for all reasonable costs of collection, including attorneys&rsquo; fees, incurred in collecting any past-due amounts.  Company reserves the right to suspend access to the Services upon written notice if any undisputed amount remains unpaid for more than fifteen (15) days after the due date.  Renewal Term prices are subject to change upon 30 days&rsquo; Notice to Customer.
      </p>

      <h2 style={h2}>3.3 Taxes</h2>
      <p style={p}>
        All Fees and other amounts payable by Customer under this Agreement are exclusive of taxes and similar assessments.  Customer is responsible for all sales, use, and excise taxes, and any other similar taxes, duties, and charges of any kind imposed by any federal, state, or local governmental or regulatory authority on any amounts payable by Customer hereunder, other than any taxes imposed on Company&rsquo;s income.
      </p>

      <h2 style={h2}>3.4 Books and Records</h2>
      <p style={p}>
        Complete books and records of all information required to verify the accuracy of Customer&rsquo;s usage of the Service must be kept for a period of 3 years.  At its own expense, Company may (through a professionally registered accountant or agent) inspect, examine, and make abstracts of such books and records as necessary to verify their accuracy.  This inspection and examination will be made during business hours upon reasonable notice, and not more often than twice a year.  Following that inspection and at the discretion of Company, Company may in addition, request that an independent auditor be allowed access to same books and records as necessary to verify their accuracy.  If the independent auditor&rsquo;s inspection reveals that the difference between the amount the independent auditor determines is owed and the amount Customer has reported is greater than five percent of the amount owed, (such difference will constitute a material breach), Customer agrees that it will then be liable to Company in the amount of three times the Fees owed (plus interest on the underpaid amount due, from the date it originally should have been paid, at the lesser of (a) 1.5% interest per month, or (b) the maximum rate allowed by law) as determined by the independent auditor plus the full cost of Licensor&rsquo;s examination and collection, including accounting, audit and legal fees.  These remedies will be in addition to any other remedies Company may have under this Agreement.
      </p>

      <h1 style={h1}>4. Confidential Information</h1>
      <p style={p}>
        <b>4.1</b> Recipient shall not disclose the disclosing Party&rsquo;s Confidential Information to any person or entity, except to Recipient&rsquo;s employees who have a need to know the Confidential Information for Recipient to exercise its rights or perform its obligations hereunder.
      </p>
      <p style={p}>
        <b>4.2</b> Notwithstanding the foregoing, a Recipient may disclose Confidential Information to the limited extent required (a) to comply with the valid order of a court or other governmental body of competent jurisdiction, or as otherwise necessary to comply with applicable law, provided that such Recipient shall first have given Notice to the other Party and made a reasonable effort to obtain a protective order; or (b) to establish a Party&rsquo;s rights under this Agreement, including to make required court filings.
      </p>
      <p style={p}>
        <b>4.3</b> On the expiration or termination of the Agreement, each Recipient shall promptly return to the disclosing Party the disclosing Party&rsquo;s Confidential Information, or destroy all such copies and certify in writing to the disclosing Party that such Confidential Information has been destroyed.
      </p>

      <h1 style={h1}>5. Representations and Warranties</h1>
      <p style={p}>
        <b>5.1</b> The Parties each represent and warranty the signatory below is authorized to the bind the Party for whom it is signing, and the Pary has the authority to enter this Agreement.
      </p>

      <h2 style={h2}>5.2 DISCLAIMER OF WARRANTY</h2>
      <p style={p}>
        (a) TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICES ARE PROVIDED &quot;AS IS&quot; WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTY OF QUALITY, MERCHANTABILITY, TITLE, NON-INFRINGEMENT AND FITNESS FOR A PARTICULAR PURPOSE, AND SUCH IMPLIED WARRANTIES, ANY OTHER WARRANTIES, REPRESENTATIONS, CONDITIONS AND TERMS, EXPRESS OR IMPLIED (AND WHETHER IMPLIED BY STATUTE, COMMON LAW, COURSE OF DEALING, TRADE USAGE OR OTHERWISE) ARE HEREBY EXCLUDED TO THE FULLEST EXTENT PERMITTED BY LAW.
      </p>
      <p style={p}>
        (b) COMPANY MAKES NO WARRANTY OF ANY KIND THAT THE SERVICES, OR ANY PRODUCTS OR RESULTS OF THE USE THEREOF OR ANY THIRD PARTY PRODUCTS, WILL MEET CUSTOMER&rsquo;S OR ANY OTHER PERSON&rsquo;S REQUIREMENTS, COMPLY WITH REGULATORY REQUIREMENTS, APPEAR PRECISELY AS DESCRIBED IN THE DOCUMENTATION, OPERATE WITHOUT INTERRUPTION, ACHIEVE ANY INTENDED RESULT, BE COMPATIBLE OR WORK WITH ANY SOFTWARE, SYSTEM, OR OTHER SERVICES, OR BE SECURE, ACCURATE, COMPLETE, OR ERROR FREE.  WITHOUT LIMITING THE GENERALITY OF THE FOREGOING DISCLAIMER, THE SERVICES ARE NOT SPECIFICALLY DESIGNED, MANUFACTURED OR INTENDED FOR USE IN FACILITIES OR ENVIRONMENTS REQUIRING FAILSAFE PERFORMANCE.
      </p>
      <p style={p}>
        (c) CUSTOMER AGREES THAT CUSTOMER IS SOLELY RESPONSIBLE FOR THE RESULTS OBTAINED FROM THE USE OF THE SERVICES.
      </p>

      <h2 style={h2}>5.3 Customer Representations and Warranties</h2>
      <p style={p}>Customer hereby represents and warrants:</p>
      <ul style={ul}>
        <li style={li}>Customer and its relevant subcontractors shall procure and maintain throughout the Term, all relevant permissions, authorizations, and licenses required for towing and parking enforcement and all actions undertaken by it in using the Services;</li>
        <li style={li}>Customer and its relevant subcontractors will fully comply with all applicable law (including but not limited to obtaining all requisite property owner authorizations for each parking facility before executing non-consent tows);</li>
        <li style={li}>Customer understands and acknowledges that Customer, and not Company, is solely responsible for Customer&rsquo;s compliance with applicable law, including but not limited to Texas Transportation Code Chapter 2308;</li>
        <li style={li}>Customer understands and acknowledges that AI-assisted license plate scanning and plate lookup are assistive tools only, and no enforcement and towing decisions are made by Company or the Service; and</li>
        <li style={li}>Customer shall maintain, and shall ensure that its relevant subcontractors maintain, throughout the Term:  (a) Commercial General Liability insurance with limits of not less than $1,000,000 per occurrence and $2,000,000 in the aggregate; (b) Commercial Auto Liability insurance with limits of not less than $1,000,000 per occurrence; and (c) any insurance required by applicable law. Customer shall provide evidence of such insurance upon request.</li>
      </ul>

      <h1 style={h1}>6. Indemnification</h1>

      <h2 style={h2}>6.1 Company Indemnification</h2>
      <p style={p}>
        In the event of any third-party claim against Customer alleging intellectual property infringement by the Service or Customer&rsquo;s use thereof (an &quot;<b>Allegation</b>&quot;), Customer shall provide Notice thereof to Company and cooperate with Company in gathering facts related to such Allegation.  Company shall indemnify, defend, and hold harmless Customer from and against any and all losses, damages, liabilities, costs (including reasonable attorneys&rsquo; fees) (&quot;<b>Losses</b>&quot;) incurred by Customer directly resulting from a final judgment of a court of competent jurisdiction from which no further appeals are possible with respect to an Allegation; provided that (a) the Allegation is based on US intellectual property rights, and (b) Customer provides Company Notice of the underlying Allegation, cooperates with Company, and allows Company sole authority to control the defense and settlement of such claim, and (c) the Allegation does not arise from the use of the Services in combination with other products, or modifications to the Services not made by Company, or Customer Data, or Prohibited Uses.  THIS PARAGRAPH SETS FORTH CUSTOMER&rsquo;S SOLE REMEDIES AND COMPANY&rsquo;S SOLE LIABILITY AND OBLIGATION FOR ANY ACTUAL, THREATENED, OR ALLEGED CLAIMS THAT THE SERVICES INFRINGE, MISAPPROPRIATE, OR OTHERWISE VIOLATE ANY INTELLECTUAL PROPERTY RIGHTS OF ANY THIRD PARTY.  IN NO EVENT WILL COMPANY&rsquo;S LIABILITY UNDER THIS PARAGRAPH EXCEED THE TOTAL AMOUNT OF FEES PAID BY CUSTOMER.
      </p>

      <h2 style={h2}>6.2 Customer Indemnification</h2>
      <p style={p}>
        Customer shall indemnify, hold harmless, and, at Company&rsquo;s option, defend Company from and against any Losses resulting from any third party Claim relating to:  (a) Customer&rsquo;s use of the Services; (b) Customer&rsquo;s breach of this Agreement or any applicable law (including Texas Transportation Code Chapter 2308); (c) Customer&rsquo;s towing, booting, or enforcement decisions and actions; (d) Customer&rsquo;s data, content, or materials submitted to the platform; or (e) Customer&rsquo;s representations to third parties about the platform.  Customer may not settle any THIRD-PARTY Claim against Company unless Company consents to such settlement, and further provided that Company will have the right, at its option, to defend itself against any such third-party Claim or to participate in the defense thereof by counsel of its own choice.
      </p>

      <h1 style={h1}>7. Limitations of Liability</h1>
      <p style={p}>
        IN NO EVENT WILL COMPANY BE LIABLE UNDER OR IN CONNECTION WITH THIS AGREEMENT UNDER ANY LEGAL OR EQUITABLE THEORY, INCLUDING BREACH OF CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, AND OTHERWISE, FOR ANY:  (a) CONSEQUENTIAL, INCIDENTAL, INDIRECT, EXEMPLARY, SPECIAL, ENHANCED, OR PUNITIVE DAMAGES; (b) INCREASED COSTS, DIMINUTION IN VALUE OR LOST BUSINESS, PRODUCTION, REVENUES, OR PROFITS; (c) LOSS OF GOODWILL OR REPUTATION; (d) USE, INABILITY TO USE, LOSS, INTERRUPTION, DELAY, OR RECOVERY OF ANY DATA, OR BREACH OF DATA OR SYSTEM SECURITY, INCLUDING FOR EXAMPLE ANY OF THE FOREGOING RESULTING FROM A SERVICE SUSPENSION; OR (e) COST OF REPLACEMENT GOODS OR SERVICES, IN EACH CASE REGARDLESS OF WHETHER COMPANY WAS ADVISED OF THE POSSIBILITY OF SUCH LOSSES OR DAMAGES OR SUCH LOSSES OR DAMAGES WERE OTHERWISE FORESEEABLE.  IN NO EVENT WILL COMPANY&rsquo;S AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT UNDER ANY LEGAL OR EQUITABLE THEORY, INCLUDING BREACH OF CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, AND OTHERWISE EXCEED THE TOTAL AMOUNTS PAID TO COMPANY UNDER THIS AGREEMENT IN THE TWELVE-MONTH PERIOD PRECEDING THE EVENT GIVING RISE TO THE CLAIM.
      </p>

      <h1 style={h1}>8. Term and Termination</h1>

      <h2 style={h2}>8.1 Term</h2>
      <p style={p}>
        The initial term of this Agreement begins on the Effective Date and, unless terminated earlier pursuant to this Agreement&rsquo;s express provisions, will continue in effect for the Subscription Term specified in Order Form (the &quot;<b>Initial Term</b>&quot;).  This Agreement will automatically renew unless earlier terminated pursuant to this Agreement&rsquo;s express provisions or either Party gives the other Party Notice of non-renewal at least thirty days prior to the expiration of the then-current term (each a &quot;<b>Renewal Term</b>&quot; and together with the Initial Term, the &quot;<b>Term</b>&quot;).
      </p>

      <h2 style={h2}>8.2 Termination</h2>
      <p style={p}>
        In addition to any other express termination right set forth in this Agreement, upon Notice:
      </p>
      <ul style={ul}>
        <li style={li}>Company may terminate this Agreement in the event (a) of a Non-Payment Period of greater than ten days; or (a) Customer breaches of any of its obligations under Section 1.2 &quot;Access,&quot; or Section 4 &quot;Confidentiality&quot;; or (c) Company determines that it is commercially appropriate due to a Service Suspension; or</li>
        <li style={li}>Either Party may terminate this Agreement if the other Party materially breaches this Agreement, and such breach:  (a) is incapable of cure; or (b) being capable of cure, remains uncured thirty (30) days after the non-breaching Party provides the breaching Party with Notice of such breach.</li>
      </ul>

      <h2 style={h2}>8.3 Expiration or Termination</h2>
      <p style={p}>
        Sections 2-9 shall survive any termination or expiration of this Agreement.  Upon expiration or earlier termination of this Agreement, Customer shall immediately discontinue use of the Service and, without limiting Customer&rsquo;s obligations under Section 5, Customer shall delete, destroy, or return all copies of the documentation and certify in writing that the documentation has been deleted or destroyed.  No expiration or termination will affect Customer&rsquo;s obligation to pay all Fees that may have become due before such expiration or termination or entitle Customer to any refund.
      </p>

      <h1 style={h1}>9. Miscellaneous</h1>

      <h2 style={h2}>9.1 Entire Agreement</h2>
      <p style={p}>
        This Agreement, together with its exhibits, order forms, and pricing schedule, constitutes the sole and entire agreement of the Parties with respect to the subject matter of this Agreement, and supersedes all prior and contemporaneous understandings, agreements, and representations and warranties, both written and oral, with respect to such subject matter.
      </p>

      <h2 style={h2}>9.2 Force Majeure</h2>
      <p style={p}>
        In no event shall Company be liable to Customer, or be deemed to have breached this Agreement, for any failure or delay in performing its obligations under this, for so long as such failure or delay is prevented, restricted, or interfered with by any circumstances beyond Company&rsquo;s reasonable control, including but not limited to acts of God, flood, fire, earthquake, other potential disasters, or catastrophes, such as epidemics, explosion, war, terrorism, invasion, riot or other civil unrest, strikes, labor stoppages or slowdowns or other industrial disturbances, or passage of law or any action taken by a governmental or public authority, including imposing an embargo.
      </p>

      <h2 style={h2}>9.3 Amendment and Modification; Waiver</h2>
      <p style={p}>
        No amendment to or modification of this Agreement is effective unless it is in writing and signed by an authorized representative of each Party.  No waiver by any Party of any of the provisions hereof will be effective unless explicitly set forth in writing and signed by the Party so waiving.  Except as otherwise set forth in this Agreement, (a) no failure to exercise, or delay in exercising, any rights, remedy, power, or privilege arising from this Agreement will operate or be construed as a waiver thereof, and (b) no single or partial exercise of any right, remedy, power, or privilege hereunder will preclude any other or further exercise thereof or the exercise of any other right, remedy, power, or privilege.
      </p>

      <h2 style={h2}>9.4 Severability</h2>
      <p style={p}>
        If any provision of this Agreement is invalid, illegal, or unenforceable in any jurisdiction, such invalidity, illegality, or unenforceability will not affect any other term or provision of this Agreement or invalidate or render unenforceable such term or provision in any other jurisdiction.  Upon such determination that any term or other provision is invalid, illegal, or unenforceable, the Parties shall negotiate in good faith to modify this Agreement so as to effect their original intent as closely as possible in a mutually acceptable manner in order that the transactions contemplated hereby be consummated as originally contemplated to the greatest extent possible.
      </p>

      <h2 style={h2}>9.5 Dispute Resolution</h2>
      <p style={p}>
        This Agreement is governed by and construed in accordance with the internal laws of the State of Texas without giving effect to any choice or conflict of law provision or rule that would require or permit the application of the laws of any jurisdiction other than those of the State of Texas.  Any legal suit, action, or proceeding arising out of or related to this Agreement or the licenses granted hereunder will be instituted exclusively in the federal courts of the United States or the courts of the State of Texas in each case located in the city of Houston, Texas and Harris County, and each Party irrevocably submits to the exclusive jurisdiction of such courts in any such suit, action, or proceeding.
      </p>
      <p style={p}>
        To the maximum extent permitted by applicable law, the Parties agree to only bring disputes in an individual capacity and shall not:  (i)  seek to bring, join, or participate in any class or representative action, collective or class-wide arbitration, or any other action where another individual or entity acts in a representative capacity (e.g., private attorney general actions); or (ii) consolidate or combine individual proceedings or permit an arbitrator to do so without the express consent of all parties to this Agreement and all other actions or arbitrations.
      </p>

      <h2 style={h2}>9.6 Assignment</h2>
      <p style={p}>
        Customer may not assign any of its rights or delegate any of its obligations hereunder, in each case whether voluntarily, involuntarily, by operation of law or otherwise, without the prior written consent of Company (a &quot;<b>Permitted Assignment</b>&quot;), which consent shall not be unreasonably withheld, conditioned, or delayed.  Any purported assignment or delegation in violation of this Agreement will be null and void.  No assignment or delegation will relieve the assigning or delegating Party of any of its obligations hereunder.  This Agreement is binding upon and inures to the benefit of the Parties and their respective permitted successors and assigns.
      </p>

      <h2 style={h2}>9.7 Export Regulation</h2>
      <p style={p}>
        Customer shall comply with all applicable federal laws, regulations, and rules, and complete all required undertakings (including obtaining any necessary export license or other governmental approval), that prohibit or restrict the export or re-export of the Services or any Customer Data outside the US.
      </p>

      <h2 style={h2}>9.8 US Government Rights</h2>
      <p style={p}>
        Each of the documentation and the software components that constitute the Services is a &quot;commercial item&quot; as that term is defined at 48 C.F.R. Section  2.101, consisting of &quot;commercial computer software&quot; and &quot;commercial computer software documentation&quot; as such terms are used in 48 C.F.R. Section  12.212.  Accordingly, if Customer is an agency of the US Government or any contractor therefor, Customer only receives those rights with respect to the Services and documentation as are granted to all other end users, in accordance with (a) 48 C.F.R. Section  227.7201 through 48 C.F.R. Section  227.7204, with respect to the Department of Defense and their contractors, or (b) 48 C.F.R. Section  12.212, with respect to all other US Government users and their contractors.
      </p>

      <h2 style={h2}>9.9 Equitable Relief</h2>
      <p style={p}>
        Customer acknowledges and agrees that a breach or threatened breach of its obligations with respect to confidentiality or Prohibited Use would cause Company irreparable harm for which monetary damages would not be an adequate remedy and agrees that, in the event of such breach or threatened breach, Company will be entitled to equitable relief, including a restraining order, an injunction, specific performance, and any other relief that may be available from any court, without any requirement to post a bond or other security, or to prove actual damages or that monetary damages are not an adequate remedy.  Such remedies are not exclusive and are in addition to all other remedies that may be available at law, in equity, or otherwise.
      </p>

      <h2 style={h2}>9.10 Counterparts</h2>
      <p style={p}>
        This Agreement may be executed in counterparts, including via electronic means, each of which is deemed an original, but all of which together are deemed to be one and the same agreement.
      </p>

      <p style={{ ...p, marginTop:'22px' }}>
        IN WITNESS WHEREOF, the Parties hereto have executed this Agreement as of the Effective Date.
      </p>

      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>COMPANY Alvarado Legacy Consulting, LLC</th>
              <th style={th}>CUSTOMER _____________</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={td}>By:  ___________________________ <em>(signature)</em></td>
              <td style={td}>By: ________________________________ <em>(signature)</em></td>
            </tr>
            <tr>
              <td style={td}>Name:  <br/>Title:  <br/>Date:</td>
              <td style={td}>Name:  <br/>Title:  <br/>Date: <br/>Address: <br/>Email Contact:</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h1 style={h1}>Exhibit A</h1>
      <h2 style={h2}>Service Level Plan</h2>

      <h2 style={h2}>1. General</h2>
      <p style={p}><strong>1.1</strong> Company will make reasonable commercial efforts to provide the service and support levels described in this Addendum, which are subject to reasonable enhancements to adapt to changing circumstances and may be updated from time to time with or without notice.</p>
      <p style={p}><strong>1.2</strong> Company maintains a distributed Application Support, with staffed coverage Monday to Friday between 8AM and 5PM Central Time.</p>
      <p style={p}><strong>1.3</strong> Company utilizes monitoring technology to proactively respond to system issues. Additionally, key Customer stakeholders are given contact numbers for Company support.</p>
      <p style={p}><strong>1.4</strong> If the IT infrastructure (server, network, etc.) is at the root cause of the problem, or hinders resolution, Company solution time will be paused until connection has been restored.</p>

      <h2 style={h2}>2. Service Levels</h2>

      <h3 style={h3}>2.1 Communication channels</h3>
      <div style={tableWrap}>
        <table style={table}>
          <thead><tr><th style={th}>Channel</th><th style={th}>Specification</th></tr></thead>
          <tbody>
            <tr><td style={td}>Email</td><td style={td}><a href="mailto:support@shieldmylot.com" style={link}>support@shieldmylot.com</a></td></tr>
          </tbody>
        </table>
      </div>

      <h3 style={h3}>2.2 Response and intervention delays</h3>
      <p style={p}>
        Company guarantees the below intervention minimums from Monday to Friday between 8AM and 5PM Central Time, excluding Federal holidays.
      </p>
      <p style={p}>
        The maximum response and intervention/solution delay depends on the severity of the reported problem. There are four levels of severity that can be identified:
      </p>
      <div style={tableWrap}>
        <table style={table}>
          <thead><tr><th style={th}>Priority</th><th style={th}>Description and criteria</th></tr></thead>
          <tbody>
            <tr>
              <td style={td}>Critical</td>
              <td style={td}>Production system is down or major workflow blocking. <em>Production environment or major functional part is unavailable resulting in critical business situation and impacting customer organization.</em></td>
            </tr>
            <tr>
              <td style={td}>Urgent</td>
              <td style={td}>Major Function/ Feature failure. <em>Causing significant disruption of workflow with moderate to low business impact.</em></td>
            </tr>
            <tr>
              <td style={td}>Medium</td>
              <td style={td}>Minor Function/ Feature failure. <em>Production environment reveals a problem and where the problem creates discomfort but with low impact.</em></td>
            </tr>
            <tr>
              <td style={td}>Low</td>
              <td style={td}>Minor Problem or Questions. <em>How-to questions, documentation related issues, general information, discussing enhancement requests, non-operational reporting, etc.</em></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 style={h3}>2.3 Response Times</h3>
      <p style={p}>
        The response time is the duration between the reception by Company of the e-mail with problem description or phone call in case of urgent/critical problems, and a phone call by Company or email confirming the receipt of the reported problem.
      </p>
      <p style={p}>Response times per term are as follows:</p>
      <div style={tableWrap}>
        <table style={table}>
          <thead><tr><th style={th}>Priority class</th><th style={th}>1hr</th><th style={th}>2hrs</th><th style={th}>4hrs</th><th style={th}>8hrs</th><th style={th}>2days</th><th style={th}>5days</th><th style={th}>30days</th></tr></thead>
          <tbody>
            <tr><td style={td}>Critical</td><td style={td}>25%</td><td style={td}>50%</td><td style={td}>100%</td><td style={td}></td><td style={td}></td><td style={td}></td><td style={td}></td></tr>
            <tr><td style={td}>Urgent</td><td style={td}>25%</td><td style={td}>50%</td><td style={td}>75%</td><td style={td}>100%</td><td style={td}></td><td style={td}></td><td style={td}></td></tr>
            <tr><td style={td}>Medium</td><td style={td}>0%</td><td style={td}>20%</td><td style={td}>40%</td><td style={td}>50%</td><td style={td}>100%</td><td style={td}></td><td style={td}></td></tr>
            <tr><td style={td}>Low</td><td style={td}>0%</td><td style={td}>0%</td><td style={td}>0%</td><td style={td}>10%</td><td style={td}>20%</td><td style={td}>70%</td><td style={td}>100%</td></tr>
          </tbody>
        </table>
      </div>

      <h3 style={h3}>2.4 Solution Times</h3>
      <p style={p}>
        The Solution time is the time that Company needs to solve the reported problem.
      </p>
      <p style={p}>
        It is calculated from the moment Company receives the e-mail describing the problem, and the moment that the problem has been solved. Again, depending on the level of severity, the solution time can be different from what has set out on the table below.
      </p>
      <p style={p}>Solution times per term are as follows:</p>
      <div style={tableWrap}>
        <table style={table}>
          <thead><tr><th style={th}>Priority class</th><th style={th}>1hr</th><th style={th}>2hrs</th><th style={th}>4hrs</th><th style={th}>8hrs</th><th style={th}>2days</th><th style={th}>5days</th><th style={th}>30days</th></tr></thead>
          <tbody>
            <tr><td style={td}>Critical</td><td style={td}>50%</td><td style={td}>60%</td><td style={td}>80%</td><td style={td}>100%</td><td style={td}></td><td style={td}></td><td style={td}></td></tr>
            <tr><td style={td}>Urgent</td><td style={td}>0%</td><td style={td}>20%</td><td style={td}>40%</td><td style={td}>50%</td><td style={td}>100%</td><td style={td}></td><td style={td}></td></tr>
            <tr><td style={td}>Medium</td><td style={td}>0%</td><td style={td}>0%</td><td style={td}>0%</td><td style={td}>10%</td><td style={td}>20%</td><td style={td}>70%</td><td style={td}>100%</td></tr>
          </tbody>
        </table>
      </div>

      <h3 style={h3}>2.5 Response and Solution Times</h3>
      <p style={p}>
        If conditions of 2.3 and 2.4 are not met, Customer is eligible to forfeit the first month subscription base fee from of the new term.
      </p>
    </div>
  )
}
